import { google } from 'googleapis';
import stream from 'stream';

const getDriveService = () => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GDRIVE_CLIENT_ID,
      process.env.GDRIVE_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );

    // This token tells Google to use your specific System Account (Account B)
    oauth2Client.setCredentials({
      refresh_token: process.env.GDRIVE_REFRESH_TOKEN
    });

    return google.drive({ version: 'v3', auth: oauth2Client });
  } catch (e) {
    console.error("📁 GDRIVE ERROR:", e.message);
    throw new Error("Server Configuration Error: Google Drive OAuth invalid.");
  }
};

export async function uploadToGoogleDrive(base64Data, fileName, mimeType, folderId = process.env.DRIVE_ROOT_FOLDER_ID || '1KFVU84_ZqiMoK5GrkAQ4s_Wzasn6Jn6t') {
  const drive = getDriveService();
  const buffer = Buffer.from(base64Data, 'base64');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const response = await drive.files.create({
    requestBody: { 
        name: fileName, 
        parents: [folderId] 
    },
    media: { mimeType: mimeType, body: bufferStream },
    fields: 'id, webViewLink',
    supportsAllDrives: true
  });

  return response.data.webViewLink;
}
