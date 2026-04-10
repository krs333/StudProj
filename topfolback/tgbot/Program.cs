using System.Text;
using System.Text.Json;
using System.Net;
using Npgsql;
using NpgsqlTypes;
using Telegram.Bot;
using Telegram.Bot.Types;
using Telegram.Bot.Types.Enums;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

string botToken =
    Environment.GetEnvironmentVariable("BOT_TOKEN")
    ?? Environment.GetEnvironmentVariable("TELEGRAM_TOKEN")
    ?? "";
string connectionString = Environment.GetEnvironmentVariable("DATABASE_URL") ?? "Host=localhost;Database=topfolio;Username=postgres;Password=твойпароль";

botToken = botToken.Trim();
if (string.IsNullOrWhiteSpace(botToken) || botToken == "ТВОЙ_ТОКЕН")
{
    Console.WriteLine("❌ BOT_TOKEN/TELEGRAM_TOKEN не задан. Укажи токен бота в .env");
    return;
}

var bot = new TelegramBotClient(botToken);
var server = new HttpListener();
int port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var p) ? p : 5001;
bool isRender = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("RENDER"));
string prefix = isRender ? $"http://*:{port}/" : $"http://localhost:{port}/";
server.Prefixes.Add(prefix);
server.Start();
Console.WriteLine($"✅ Бот запущен: {prefix}");

string BuildConnectionString(string raw)
{
    var builder = new NpgsqlConnectionStringBuilder(raw);
    bool isRender = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("RENDER"));

    if (isRender)
    {
        builder.SslMode = SslMode.Require;
        builder.TrustServerCertificate = true;
    }
    else
    {
        builder.SslMode = SslMode.Disable;
        builder.TrustServerCertificate = false;
    }

    return builder.ConnectionString;
}

string effectiveConnectionString = BuildConnectionString(connectionString);
string NormalizeUsername(string value) => (value ?? string.Empty).Trim().TrimStart('@').ToLowerInvariant();

// Запускаем обработку обновлений в фоне
_ = Task.Run(() => HandleUpdates());

// ==================== НОВЫЙ КОД: Healthcheck для Render ====================
// Добавляем отдельный поток для обработки healthcheck запросов
_ = Task.Run(() => RunHealthCheckServer());

async Task RunHealthCheckServer()
{
    var healthServer = new HttpListener();
    int healthPort = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var hp) ? hp : 8080;
    string healthPrefix = isRender ? $"http://*:{healthPort}/health" : $"http://localhost:{healthPort}/health";
    healthServer.Prefixes.Add(healthPrefix);
    healthServer.Start();
    Console.WriteLine($"❤️ Healthcheck сервер запущен на {healthPrefix}");
    
    while (true)
    {
        try
        {
            var context = await healthServer.GetContextAsync();
            context.Response.StatusCode = 200;
            byte[] buffer = Encoding.UTF8.GetBytes("OK");
            context.Response.OutputStream.Write(buffer, 0, buffer.Length);
            context.Response.Close();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Healthcheck error: {ex.Message}");
        }
    }
}
// =========================================================================

// Основной цикл обработки запросов (твоя старая логика)
while (true)
{
    try
    {
        var context = await server.GetContextAsync();
        _ = Task.Run(() => ProcessRequest(context));
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Ошибка в основном цикле: {ex.Message}");
    }
}

async Task HandleUpdates()
{
    int offset = 0;
    while (true)
    {
        try
        {
            var updates = await bot.GetUpdatesAsync(offset);
            foreach (var update in updates)
            {
                if (update.Message?.Text == "/start" && update.Message?.From?.Username != null)
                {
                    string username = NormalizeUsername(update.Message.From.Username);
                    long chatId = update.Message.Chat.Id;
                    await SaveChatId(username, chatId);
                    await bot.SendTextMessageAsync(chatId, "✅ Вы зарегистрированы!");
                }
                offset = update.Id + 1;
            }
        }
        catch (Exception ex) { Console.WriteLine($"Ошибка HandleUpdates: {ex.Message}{(ex.InnerException != null ? $" | Inner: {ex.InnerException.Message}" : "")}"); }
        await Task.Delay(1000);
    }
}

async Task SaveChatId(string username, long chatId)
{
    using var conn = new NpgsqlConnection(effectiveConnectionString);
    await conn.OpenAsync();
    string normalized = NormalizeUsername(username);
    string sql = @"UPDATE designers 
                   SET telegram_chat_id = @chatId 
                   WHERE lower(trim(leading '@' from telegramusername)) = @username";
    using var cmd = new NpgsqlCommand(sql, conn);
    cmd.Parameters.AddWithValue("@username", normalized);
    cmd.Parameters.AddWithValue("@chatId", chatId);
    var updated = await cmd.ExecuteNonQueryAsync();
    if (updated > 0)
    {
        Console.WriteLine($"✅ Сохранен chat_id для @{normalized}");
    }
    else
    {
        Console.WriteLine($"⚠️ Дизайнер @{normalized} не найден в БД (сначала сохрани профиль на сайте)");
    }
}

async Task<long?> GetChatId(string username)
{
    using var conn = new NpgsqlConnection(effectiveConnectionString);
    await conn.OpenAsync();
    string normalized = NormalizeUsername(username);
    string sql = @"SELECT telegram_chat_id 
                   FROM designers 
                   WHERE lower(trim(leading '@' from telegramusername)) = @username";
    using var cmd = new NpgsqlCommand(sql, conn);
    cmd.Parameters.AddWithValue("username", normalized);
    var result = await cmd.ExecuteScalarAsync();
    return result as long?;
}

async Task ProcessRequest(HttpListenerContext context)
{
    if (context.Request.Url?.AbsolutePath == "/notify" && context.Request.HttpMethod == "POST")
    {
        using var reader = new StreamReader(context.Request.InputStream);
        string body = await reader.ReadToEndAsync();
        var data = JsonSerializer.Deserialize<NotifyRequest>(body);
        
        if (data?.DesignerUsername != null)
        {
            string clean = NormalizeUsername(data.DesignerUsername);
            long? chatId = await GetChatId(clean);
            
            if (chatId != null)
            {
                await bot.SendTextMessageAsync(chatId.Value, $"🎨 Отклик!\nКлиент: {data.ClientContact}");
                context.Response.StatusCode = 200;
            }
            else
            {
                context.Response.StatusCode = 404;
            }
        }
        else
        {
            context.Response.StatusCode = 400;
        }
        context.Response.Close();
    }
}

class NotifyRequest 
{
    [JsonPropertyName("designerUsername")]
    public string DesignerUsername { get; set; } = "";
    
    [JsonPropertyName("clientContact")]
    public string ClientContact { get; set; } = "";
}
