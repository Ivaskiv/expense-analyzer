require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Ініціалізація Google AI
const genAI = new GoogleGenerativeAI(process.env.PALM_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// Промпт для аналізу витрат
const EXPENSE_PROMPT = `проаналізуй ці витрати "INPUT_TEXT" в форматі"сума, категорія витрат", сума без вказання валюти - тільки число. В якості категорії витрат бери категорії (продукти, кафе, покупки, ком послуги, спорт, інші). Повертай лише суму і категорію, без пояснень`;

// Ініціалізація бота
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Обробка команди /start
bot.start((ctx) => {
  ctx.reply('Привіт! Надішли мені інформацію про витрати, я їх проаналізую.');
});

// Обробка текстових повідомлень
bot.on('text', async (ctx) => {
  try {
    const userText = ctx.message.text;
    
    // Пропускаємо команди
    if (userText.startsWith('/')) return;
    
    // Показуємо статус "друкує..."
    ctx.replyWithChatAction('typing');
    
    // Формуємо промпт з текстом користувача
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', userText);
    
    // Відправляємо запит до Google PaLM API
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // Відправляємо відповідь користувачу
    ctx.reply(response);
  } catch (error) {
    console.error('Помилка:', error);
    ctx.reply('Виникла помилка при аналізі витрат. Спробуйте ще раз.');
  }
});

// Запуск бота
bot.launch().then(() => {
  console.log('Бот запущено!');
}).catch((err) => {
  console.error('Помилка запуску бота:', err);
});

// Обробка зупинки
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));