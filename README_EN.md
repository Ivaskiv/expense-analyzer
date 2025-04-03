# 💰 Telegram Expense Tracker Bot

A Telegram bot that helps you track your expenses through text and voice messages. The bot automatically analyzes your expenses, categorizes them, and saves them to a Google Spreadsheet.

## 📋 Features

- 🗣️ Voice message recognition using Wit.ai
- 📝 Text message analysis for expense tracking
- 🔍 Automatic detection of expense amount and category
- 🗂️ Multiple expense categories
- 📊 Integration with Google Sheets for data storage
- ✏️ Ability to modify amount and category before confirmation

## 🚀 Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Google Cloud account with Google Sheets API enabled
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Wit.ai account (optional, for voice recognition)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/telegram-expense-tracker.git
   cd telegram-expense-tracker
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with the following variables:
   ```
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   WIT_AI_TOKEN=your_wit_ai_token
   PORT=3000
   
   # Google Sheets configuration
   GOOGLE_SERVICE_ACCOUNT_EMAIL=your_service_account_email
   GOOGLE_PRIVATE_KEY=your_private_key
   GOOGLE_SHEET_ID=your_google_sheet_id
   
   # Optional for webhook mode
   USE_WEBHOOK=false
   WEBHOOK_DOMAIN=your_domain.com
   ```

4. Make sure the Google Spreadsheet has these columns:
   - Дата (Date)
   - Сума (Amount)
   - Категорія (Category)
   - Запис (Note)

### Google Sheets Setup

1. Create a new Google Cloud project
2. Enable the Google Sheets API
3. Create a service account and download the credentials
4. Share your Google Spreadsheet with the service account email
5. Add the required fields to your `.env` file

## 🚀 Running the Bot

### Development Mode

```bash
npm start
```

### Production Mode (with PM2)

```bash
npm install -g pm2
pm2 start index.js --name expense-tracker-bot
```

## 📱 Using the Bot

1. Start a conversation with your bot on Telegram
2. Send a text message describing your expense, for example:
   - "Bought groceries for 450 UAH"
   - "Paid 1200 for utilities"
   - "Coffee 85 UAH"

3. Alternatively, send a voice message describing your expense

4. The bot will analyze your message and suggest an amount and category
   - Confirm the expense to save it to Google Sheets
   - Change the category if needed
   - Modify the amount if needed

5. After confirmation, the expense will be saved to your Google Spreadsheet

## 📊 Default Categories

- 📦 продукти (groceries)
- ☕ кафе (cafes/restaurants)
- 🛍️ покупки (shopping)
- 🏠 комунальні послуги (utilities)
- 🏋️ спорт (sports)
- 📚 канцтовари (stationery)
- 📝 інші (other)

Additional categories detected:
- 🚗 транспорт (transport)
- 🎭 розваги (entertainment)
- 💊 здоров'я (health)

## 🛠️ Customization

You can modify the `DEFAULT_CATEGORIES` array in the code to add or change expense categories.

## 🧠 How It Works

1. The bot receives a text or voice message
2. For voice messages, it sends the audio to Wit.ai for transcription
3. The bot analyzes the text to extract the expense amount and category
4. The user confirms or modifies the detected information
5. Upon confirmation, the data is saved to a Google Spreadsheet

## 🔄 API Endpoints

- `/health` - Check the health status of the bot
- `/webhook` - Endpoint for Telegram webhook (if enabled)

## 🌐 Deployment

You can deploy this bot on any Node.js hosting service. For webhook mode, make sure your server has HTTPS enabled and set the `USE_WEBHOOK=true` and `WEBHOOK_DOMAIN` in your `.env` file.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgements

- [Telegraf.js](https://github.com/telegraf/telegraf) - Telegram Bot framework
- [Wit.ai](https://wit.ai/) - Natural language processing
- [Google Sheets API](https://developers.google.com/sheets/api) - Data storage