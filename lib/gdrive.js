import { google } from 'googleapis';
import stream from 'stream';

const getDriveService = () => {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
  } catch (e) {
    console.error("📁 GDRIVE ERROR: Your GOOGLE_SERVICE_ACCOUNT_JSON is malformed or missing.", e.message);
    throw new Error("Server Configuration Error: Google Drive JSON invalid.");
  }
};

export async function uploadToGoogleDrive(base64Data, fileName, mimeType, folderId = process.env.DRIVE_ROOT_FOLDER_ID || '1KFVU84_ZqiMoK5GrkAQ4s_Wzasn6Jn6t') {
  const drive = getDriveService();
  const buffer = Buffer.from(base64Data, 'base64');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: mimeType, body: bufferStream },
    fields: 'id, webViewLink'
  });
  return response.data.webViewLink;
}
