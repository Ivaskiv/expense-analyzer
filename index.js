require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.PALM_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const EXPENSE_PROMPT = `проаналізуй ці витрати "INPUT_TEXT" в форматі"сума, категорія витрат", сума без вказання валюти - тільки число. В якості категорії витрат бери категорії (продукти, кафе, покупки, ком послуги, спорт, інші). Повертай лише суму і категорію, без пояснень`;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Привіт! Надішли мені інформацію про витрати, я їх проаналізую.');
});

bot.on('text', async (ctx) => {
  try {
    const userText = ctx.message.text;
    if (userText.startsWith('/')) return;
    
    await ctx.replyWithChatAction('typing');
    
    const prompt = EXPENSE_PROMPT.replace('INPUT_TEXT', userText);
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    await ctx.reply(response);
  } catch (error) {
    console.error('Помилка:', error);
    await ctx.reply('Виникла помилка при аналізі витрат. Спробуйте ще раз.');
  }
});

if (process.env.WEBHOOK_URL) {
  bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
  app.use(express.json());
  app.use(bot.webhookCallback('/webhook'));
} else {
  bot.launch().then(() => console.log('Бот запущено!'));
}

app.get('/', (req, res) => {
  res.send('Бот працює!');
});

app.listen(PORT, () => {
  console.log(`Сервер працює на порту ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
