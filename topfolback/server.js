import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: 'https://topfolio.netlify.app/',
    credentials: true
}));

// Увеличиваем лимит ДО 50 МБ для фото!
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

function normalizeTelegramUsername(value = '') {
    return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

async function testDB() {
    try {
        const res = await pool.query('SELECT NOW()');
        console.log('✅ PostgreSQL подключён успешно!');
    } catch (err) {
        console.error('❌ Ошибка подключения к PostgreSQL:', err.message);
    }
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

// ПОЛУЧИТЬ ВСЕХ ДИЗАЙНЕРОВ (для ленты)
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
        
        console.log('Найдено:', result.rows.length);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Дизайнер не найден' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: error.message });
    }
});
// СОХРАНЕНИЕ ПРОФИЛЯ ДИЗАЙНЕРА (с фото)
app.post('/api/designer-profile', async (req, res) => {
    console.log('🎨 Сохранение профиля дизайнера, фото:', req.body.works?.length || 0);
    try {
        const { name, bio, telegramUsername } = req.body;
        const userId = req.body.userId || req.body.id;
        const contactInfo = normalizeContactInfo(req.body);
        const works = normalizeWorks(req.body);
        const normalizedTelegramUsername = normalizeTelegramUsername(telegramUsername || contactInfo);
        
        if (!userId || !name || !contactInfo || !normalizedTelegramUsername) {
            return res.status(400).json({ success: false, message: 'Не хватает данных' });
        }
        
        // Обновляем пользователя
        const userUpdateResult = await pool.query(
            'UPDATE Users SET Name = $1, ContactInfo = $2, Role = $3 WHERE Id = $4',
            [name, contactInfo, 'designer', userId]
        );
        if (userUpdateResult.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        }
        
        // Сохраняем данные дизайнера
        await pool.query(
            `INSERT INTO Designers (UserId, Bio, TelegramUsername) VALUES ($1, $2, $3) 
             ON CONFLICT (UserId) DO UPDATE SET Bio = $2, TelegramUsername = $3`,
            [userId, bio || '', normalizedTelegramUsername]
        );
        
        // Удаляем старые работы
        await pool.query('DELETE FROM Works WHERE DesignerId = $1', [userId]);
        
        // Добавляем новые работы
        let savedCount = 0;
        const worksToSave = works;
        const MAX_IMAGE_LENGTH = 50 * 1024 * 1024; // до 50MB строкой
        for (const work of worksToSave) {
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
        console.log('✅ Клиент сохранён:', updateResult.rows[0]);
        res.json({ success: true, user: updateResult.rows[0] });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ПОЛУЧИТЬ ПРОФИЛЬ КЛИЕНТА (для личного кабинета)
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
        console.log('✅ Клиент сохранён (PUT без params):', updateResult.rows[0]);
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
        const designerUsername = normalizeTelegramUsername(designerRes.rows[0]?.telegramusername || '');
        if (!designerUsername) {
            return res.status(404).json({
                success: false,
                message: 'У дизайнера не указан Telegram username'
            });
        }
        
        // 1. Сохраняем отклик в базу данных (если нужно хранить историю)
        const result = await pool.query(
            `INSERT INTO Feedbacks (designer_id, client_contact, client_name, created_at) 
             VALUES ($1, $2, $3, NOW()) RETURNING id`,
            [designerId, clientContact, clientName || 'Клиент']
        );
        
        console.log(`✅ Отклик сохранён в БД, ID: ${result.rows[0].id}`);
        
        // 2. Отправляем уведомление в C# бота
        const BOT_URL = process.env.BOT_URL || 'http://localhost:5001';
        
        try {
            // Используем fetch (в Node.js 18+ уже встроен)
            const notifyResponse = await fetch(`${BOT_URL}/notify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    designerUsername: designerUsername,  // Telegram username дизайнера
                    clientContact: clientContact         // Контакт клиента (телефон или @username)
                })
            });
            
            if (notifyResponse.ok) {
                console.log(`✅ Уведомление отправлено дизайнеру @${designerUsername}`);
            } else if (notifyResponse.status === 404) {
                console.log(`⚠️ Дизайнер @${designerUsername} не активировал бота`);
            } else {
                console.log(`⚠️ Бот вернул статус: ${notifyResponse.status}`);
            }
        } catch (botError) {
            // Не прерываем выполнение, если бот недоступен
            console.error('❌ Ошибка связи с ботом:', botError.message);
        }
        
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
app.listen(PORT, async () => {
    console.log(`🚀 Backend запущен на порту ${PORT}`);
    await testDB();
});
