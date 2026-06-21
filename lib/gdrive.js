import { google } from 'googleapis';
import stream from 'stream';

// You will paste your Google Service Account JSON into a Vercel Env Variable
const getDriveService = () => {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  return google.drive({ version: 'v3', auth });
};

export async function uploadToGoogleDrive(base64Data, fileName, mimeType, folderId = process.env.DRIVE_ROOT_FOLDER_ID) {
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