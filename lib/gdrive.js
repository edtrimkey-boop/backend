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
import { google } from 'googleapis';
import stream from 'stream';

const getDriveService = () => {
  const clientId = process.env.GDRIVE_CLIENT_ID;
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Server Configuration Error: Missing Google Drive variables.");
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, "https://developers.google.com/oauthplayground");
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
};

// 🔥 NEW: Function to navigate and create nested folders!
export async function getOrCreateFolder(folderName, parentFolderId) {
  const drive = getDriveService();
  try {
    const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q: q, fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    
    if (res.data.files && res.data.files.length > 0) return res.data.files[0].id; // Folder exists

    const folder = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
      fields: 'id', supportsAllDrives: true
    });
    return folder.data.id; // New folder created
  } catch (err) {
    console.error("FOLDER CREATION ERROR:", err);
    throw new Error("Failed to map Google Drive folders.");
  }
}

export async function uploadToGoogleDrive(base64Data, fileName, mimeType, folderId) {
  const drive = getDriveService();
  const buffer = Buffer.from(base64Data, 'base64');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: mimeType, body: bufferStream },
    fields: 'id, webViewLink', supportsAllDrives: true
  });
  return response.data.webViewLink;
}
