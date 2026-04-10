import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import { Telegraf } from 'telegraf';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: 'https://topfolio.netlify.app',
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((req, res, next) => {
    console.log(`➡️ ${req.method} ${req.path}`);
    next();
});

// ==================== БАЗА ДАННЫХ ====================
const { Pool } = pg;
const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })
    : new Pool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'topfolio',
    });

async function testDB() {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ PostgreSQL подключён успешно!');
    } catch (err) {
        console.error('❌ Ошибка подключения к PostgreSQL:', err.message);
    }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function normalizeContactInfo(body = {}) {
    const value =
        body.contactInfo ??
        body.contactinfo ??
        body.contact ??
        body.telegram ??
        body.phone ??
        '';
    return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function normalizeWorks(body = {}) {
    const raw = body.works ?? body.worksList ?? body.images ?? body.portfolio ?? [];
    return Array.isArray(raw) ? raw : [];
}

function normalizeUsername(value = '') {
    return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

// ==================== TELEGRAM БОТ ====================
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
let bot = null;

async function sendTelegramNotification(designerUsername, clientContact) {
    if (!bot) {
        console.warn('⚠️ Бот не запущен, уведомление не отправлено');
        return false;
    }

    try {
        const normalized = normalizeUsername(designerUsername);
        const result = await pool.query(
            'SELECT telegram_chat_id FROM designers WHERE lower(trim(leading \'@\' from telegramusername)) = $1',
            [normalized]
        );

        const chatId = result.rows[0]?.telegram_chat_id;

        if (!chatId) {
            console.log(`⚠️ Дизайнер @${normalized} не активировал бота`);
            return false;
        }

        await bot.telegram.sendMessage(chatId, `🎨 Новый отклик!\nКлиент: ${clientContact}`);
        console.log(`✅ Уведомление отправлено дизайнеру @${normalized}`);
        return true;

    } catch (err) {
        console.error('Ошибка отправки уведомления:', err.message);
        return false;
    }
}

if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    bot.start(async (ctx) => {
        const username = normalizeUsername(ctx.from?.username || '');
        const chatId = ctx.chat.id;
        if (!username) {
            return ctx.reply('❌ У вас не задан Telegram username.');
        }
        try {
            const result = await pool.query(
                'UPDATE designers SET telegram_chat_id = $1 WHERE lower(trim(leading \'@\' from telegramusername)) = $2',
                [chatId, username]
            );
            if (result.rowCount > 0) {
                console.log(`✅ Сохранён chat_id для @${username}`);
                await ctx.reply('✅ Вы зарегистрированы! Теперь будете получать уведомления об откликах.');
            } else {
                console.log(`⚠️ Дизайнер @${username} не найден в БД`);
                await ctx.reply('⚠️ Ваш профиль не найден. Сначала сохраните профиль на сайте.');
            }
        } catch (err) {
            console.error('Ошибка сохранения chat_id:', err.message);
            await ctx.reply('❌ Ошибка сервера.');
        }
    });
    bot.launch().then(() => console.log('🤖 Telegram бот запущен'));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
    console.warn('⚠️ BOT_TOKEN не задан — Telegram бот не запущен');
}

// ==================== РОУТЫ ====================
app.get('/', (req, res) => {
    res.json({ message: '✅ Topfolio Backend is running!' });
});

// РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
    console.log('📝 Регистрация:', req.body);
    try {
        const { name, login, password } = req.body;

        if (!name || !login || !password) {
            return res.status(400).json({ success: false, message: 'Заполните все поля' });
        }

        const existing = await pool.query('SELECT * FROM Users WHERE Login = $1', [login]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Логин уже занят' });
        }

        const result = await pool.query(
            'INSERT INTO Users (Name, Login, Password) VALUES ($1, $2, $3) RETURNING Id, Name, Login',
            [name, login, password]
        );

        res.json({ success: true, message: 'Регистрация прошла успешно', userId: result.rows[0].id });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ВХОД
app.post('/api/login', async (req, res) => {
    console.log('🔑 Вход:', req.body.login);
    try {
        const { login, password } = req.body;

        if (!login || !password) {
            return res.status(400).json({ success: false, message: 'Введите логин и пароль' });
        }

        const result = await pool.query(
            'SELECT Id, Name, Login, Role, ContactInfo FROM Users WHERE Login = $1 AND Password = $2',
            [login, password]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
        }

        const user = result.rows[0];
        let designerData = null;
        let works = [];

        if (user.role === 'designer') {
            const dRes = await pool.query('SELECT * FROM Designers WHERE UserId = $1', [user.id]);
            if (dRes.rows.length > 0) designerData = dRes.rows[0];
            const wRes = await pool.query(
                'SELECT Id, ImageUrl AS url, Title AS title FROM Works WHERE DesignerId = $1 ORDER BY Id ASC',
                [user.id]
            );
            works = wRes.rows;
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                login: user.login,
                role: user.role,
                contactInfo: user.contactinfo || '',
                designerData,
                works
            }
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ПОЛУЧИТЬ ВСЕХ ДИЗАЙНЕРОВ
app.get('/api/designers', async (req, res) => {
    console.log('📋 Запрос списка дизайнеров');
    try {
        const designers = await pool.query(`
            SELECT u.Id, u.Name, d.Bio, d.TelegramUsername,
                   COALESCE(
                     json_agg(
                       json_build_object('url', w.ImageUrl, 'title', COALESCE(w.Title, ''))
                     ) FILTER (WHERE w.Id IS NOT NULL),
                     '[]'
                   ) as works
            FROM Users u
            JOIN Designers d ON u.Id = d.UserId
            LEFT JOIN Works w ON u.Id = w.DesignerId
            WHERE u.Role = 'designer'
            GROUP BY u.Id, d.UserId
        `);
        res.json(designers.rows);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: error.message });
    }
});

// ПОЛУЧИТЬ ОДНОГО ДИЗАЙНЕРА ПО ID
app.get('/api/designers/:id', async (req, res) => {
    console.log('📋 Запрос дизайнера по ID:', req.params.id);
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT u.Id, u.Name, u.ContactInfo, d.Bio, d.TelegramUsername,
                   COALESCE(
                     json_agg(
                       json_build_object('url', w.ImageUrl, 'title', COALESCE(w.Title, ''))
                     ) FILTER (WHERE w.Id IS NOT NULL),
                     '[]'
                   ) as works
            FROM Users u
            JOIN Designers d ON u.Id = d.UserId
            LEFT JOIN Works w ON u.Id = w.DesignerId
            WHERE u.Id = $1 AND u.Role = 'designer'
            GROUP BY u.Id, d.UserId
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Дизайнер не найден' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: error.message });
    }
});

// СОХРАНЕНИЕ ПРОФИЛЯ ДИЗАЙНЕРА
app.post('/api/designer-profile', async (req, res) => {
    console.log('🎨 Сохранение профиля дизайнера, фото:', req.body.works?.length || 0);
    try {
        const { name, bio, telegramUsername } = req.body;
        const userId = req.body.userId || req.body.id;
        const contactInfo = normalizeContactInfo(req.body);
        const works = normalizeWorks(req.body);
        const normalizedTelegramUsername = normalizeUsername(telegramUsername || contactInfo);

        if (!userId || !name || !contactInfo || !normalizedTelegramUsername) {
            return res.status(400).json({ success: false, message: 'Не хватает данных' });
        }

        await pool.query(
            'UPDATE Users SET Name = $1, ContactInfo = $2, Role = $3 WHERE Id = $4',
            [name, contactInfo, 'designer', userId]
        );

        await pool.query(
            `INSERT INTO Designers (UserId, Bio, TelegramUsername) VALUES ($1, $2, $3) 
             ON CONFLICT (UserId) DO UPDATE SET Bio = $2, TelegramUsername = $3`,
            [userId, bio || '', normalizedTelegramUsername]
        );

        await pool.query('DELETE FROM Works WHERE DesignerId = $1', [userId]);

        const MAX_IMAGE_LENGTH = 50 * 1024 * 1024;
        let savedCount = 0;
        for (const work of works) {
            const imageUrl =
                typeof work === 'string'
                    ? work
                    : work?.url || work?.imageUrl || work?.image || work?.src || '';
            if (imageUrl && imageUrl.length < MAX_IMAGE_LENGTH) {
                await pool.query(
                    'INSERT INTO Works (DesignerId, ImageUrl, Title) VALUES ($1, $2, $3)',
                    [userId, imageUrl, work?.title || '']
                );
                savedCount++;
            }
        }

        console.log(`✅ Сохранено ${savedCount} фото`);
        res.json({ success: true, message: 'Профиль сохранён' });
    } catch (error) {
        console.error('Ошибка сохранения дизайнера:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// СОХРАНЕНИЕ ПРОФИЛЯ КЛИЕНТА
app.post('/api/client-profile', async (req, res) => {
    console.log('👤 Сохранение клиента:', req.body.name);
    try {
        const userId = req.body.userId || req.body.id;
        const { name } = req.body;
        const contactInfo = normalizeContactInfo(req.body);

        if (!userId || !name) {
            return res.status(400).json({ success: false, message: 'Не хватает данных' });
        }

        const updateResult = await pool.query(
            'UPDATE Users SET Name = $1, ContactInfo = $2, Role = $3 WHERE Id = $4 RETURNING Id, Name, ContactInfo, Role',
            [name, contactInfo, 'client', userId]
        );

        if (updateResult.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        }

        res.json({ success: true, user: updateResult.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ПОЛУЧИТЬ ПРОФИЛЬ КЛИЕНТА
app.get('/api/client-profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query('SELECT Id, Name, ContactInfo, Role FROM Users WHERE Id = $1', [userId]);
        res.json(result.rows[0] || null);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ОБНОВИТЬ ПРОФИЛЬ КЛИЕНТА
app.put('/api/client-profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { name } = req.body;
        const contactInfo = normalizeContactInfo(req.body);

        if (!name) {
            return res.status(400).json({ success: false, message: 'Введите имя' });
        }

        const updateResult = await pool.query(
            'UPDATE Users SET Name = $1, ContactInfo = $2 WHERE Id = $3 RETURNING Id, Name, ContactInfo, Role',
            [name, contactInfo, userId]
        );

        if (updateResult.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        }

        res.json({ success: true, user: updateResult.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ОБНОВИТЬ ПРОФИЛЬ КЛИЕНТА 
app.put('/api/client-profile', async (req, res) => {
    try {
        const userId = req.body.userId || req.body.id;
        const { name } = req.body;
        const contactInfo = normalizeContactInfo(req.body);

        if (!userId || !name) {
            return res.status(400).json({ success: false, message: 'Не хватает данных' });
        }

        const updateResult = await pool.query(
            'UPDATE Users SET Name = $1, ContactInfo = $2, Role = $3 WHERE Id = $4 RETURNING Id, Name, ContactInfo, Role',
            [name, contactInfo, 'client', userId]
        );

        if (updateResult.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        }

        res.json({ success: true, user: updateResult.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ОТПРАВКА ОТКЛИКА КЛИЕНТОМ ДИЗАЙНЕРУ
app.post('/api/send-feedback', async (req, res) => {
    console.log('💬 Получен отклик от клиента:', req.body);
    try {
        const { designerId, clientContact, clientName } = req.body;

        if (!designerId || !clientContact) {
            return res.status(400).json({
                success: false,
                message: 'Не хватает данных: designerId, clientContact'
            });
        }

        const designerRes = await pool.query(
            'SELECT TelegramUsername FROM Designers WHERE UserId = $1',
            [designerId]
        );
        const designerUsername = normalizeUsername(designerRes.rows[0]?.telegramusername || '');

        if (!designerUsername) {
            return res.status(404).json({
                success: false,
                message: 'У дизайнера не указан Telegram username'
            });
        }

        const result = await pool.query(
            `INSERT INTO Feedbacks (designer_id, client_contact, client_name, created_at) 
             VALUES ($1, $2, $3, NOW()) RETURNING id`,
            [designerId, clientContact, clientName || 'Клиент']
        );

        console.log(`✅ Отклик сохранён в БД, ID: ${result.rows[0].id}`);

        await sendTelegramNotification(designerUsername, clientContact);

        res.json({
            success: true,
            message: 'Отклик успешно отправлен дизайнеру'
        });

    } catch (error) {
        console.error('Ошибка при отправке отклика:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка сервера при отправке отклика'
        });
    }
});

// ==================== ЗАПУСК ====================
app.listen(PORT, async () => {
    console.log(`🚀 Backend запущен на порту ${PORT}`);
    await testDB();
});
