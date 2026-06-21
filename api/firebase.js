import admin from 'firebase-admin';

export async function sendPushNotification(tokens, title, body) {
  if (!tokens || tokens.length === 0) return { success: false, message: 'No tokens provided' };
  
  // Initialize safely inside the function
  if (!admin.apps.length) {
    try {
      const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } catch (e) {
      console.error("🔥 FIREBASE ERROR: Your GOOGLE_SERVICE_ACCOUNT_JSON is malformed or missing.", e.message);
      return { success: false, error: "Server Configuration Error: Firebase JSON invalid." };
    }
  }

  const message = {
    notification: { title, body },
    tokens: tokens 
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    return { success: true, successCount: response.successCount, failureCount: response.failureCount };
  } catch (error) {
    console.error('Error sending message:', error);
    return { success: false, error: error.message };
  }
}
