// Audio processing with better error handling and cloud API fallback
async function processAudio(fileId, ctx) {
  const processingMsg = await ctx.reply('🔄 Обробляю ваше аудіо...');
  let oggPath = null;
  let wavPath = null;
  
  try {
    // Download audio file
    oggPath = await downloadAudioFile(fileId);
    
    // Convert audio format
    wavPath = await convertOggToWav(oggPath);
    
    // Try to transcribe with Whisper first
    let transcribedText;
    try {
      transcribedText = await transcribeAudioWithWhisper(wavPath);
    } catch (whisperError) {
      console.log('Whisper failed, trying fallback transcription service');
      // Fallback to a cloud-based speech recognition service
      transcribedText = await fallbackTranscription(wavPath);
    }
    
    if (!transcribedText || transcribedText.trim() === '') {
      throw new Error('Transcription returned empty text');
    }
    
    console.log('Transcribed text:', transcribedText);
    
    // Process the transcribed text
    const data = {
      type: 'TEXT',
      content: transcribedText,
      userId: ctx.message.from.id,
      messageId: ctx.message.message_id,
      timestamp: new Date().toISOString()
    };
    
    const result = await routeToRouter(data);
    
    // Delete processing message on success
    await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
    
    return result;
  } catch (error) {
    console.error('Audio processing error:', error);
    
    // Update message to show error
    ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      '❌ Не вдалося розпізнати аудіо. Спробуйте відправити текстове повідомлення.'
    ).catch(() => {});
    
    throw error;
  } finally {
    // Always clean up files
    cleanupFiles([oggPath, wavPath].filter(Boolean));
  }
}

// Fallback transcription service
async function fallbackTranscription(audioPath) {
  try {
    // Read the audio file
    const audioBuffer = fs.readFileSync(audioPath);
    
    // Use Google Speech-to-Text API as a fallback
    // You'll need to set up Google Cloud credentials
    const speech = require('@google-cloud/speech').v1p1beta1;
    const client = new speech.SpeechClient();
    
    const request = {
      audio: {
        content: audioBuffer.toString('base64')
      },
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'uk-UA',
      }
    };
    
    const [response] = await client.recognize(request);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    
    return transcription;
  } catch (error) {
    console.error('Fallback transcription error:', error);
    throw error;
  }
}

// Improved error handling for webhook setup
function setupWebhook() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is not set!');
    process.exit(1);
  }
  
  if (!WEBHOOK_URL) {
    console.warn('WARNING: WEBHOOK_URL is not set. Falling back to polling mode.');
    return bot.launch()
      .then(() => {
        console.log('Bot started in polling mode');
        botRunning = true;
      })
      .catch(err => {
        console.error('Error starting bot in polling mode:', err);
        process.exit(1);
      });
  }
  
  const webhookUrl = `${WEBHOOK_URL}${webhookPath}`;
  return bot.telegram.setWebhook(webhookUrl)
    .then(() => {
      console.log(`Webhook set up successfully at ${webhookUrl}`);
      botRunning = true;
    })
    .catch(err => {
      console.error('Error setting up webhook:', err);
      console.log('Falling back to polling mode...');
      return bot.launch()
        .then(() => {
          console.log('Bot started in polling mode after webhook failure');
          botRunning = true;
        })
        .catch(launchErr => {
          console.error('Failed to start bot in polling mode:', launchErr);
          process.exit(1);
        });
    });
}

// Improved voice handler
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const fileId = ctx.message.voice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    await processAudio(fileId, ctx);
  } catch (error) {
    console.error('Voice processing error:', error);
    ctx.reply('❌ Виникла помилка при обробці вашого аудіо. Спробуйте знову або відправте текстове повідомлення.')
      .catch(err => console.error('Error sending error message:', err));
  }
});

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({
    error: 'Внутрішня помилка сервера',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Improved server startup sequence
async function startServer() {
  try {
    // Start Express server
    server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      
      // Set up bot after server is started
      setupWebhook().catch(err => {
        console.error('Fatal error during webhook setup:', err);
        process.exit(1);
      });
    });
    
    // Add proper error handling for the server
    server.on('error', (err) => {
      console.error('Server error:', err);
      process.exit(1);
    });
  } catch (error) {
    console.error('Fatal error during server startup:', error);
    process.exit(1);
  }
}

// Start the server
startServer();