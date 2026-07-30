require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Google Auth
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ],
});

const SPREADSHEET_ID = '1tO5CBWVi0zAlowfCyQ7XHQh0qkz4Qx1vgpv42qVTeNs';
const SHEET_NAME = 'Call Audit Folders (SE)';

async function getFirmFolderMap() {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!B:E`,
  });

  const rows = res.data.values || [];
  const map = {};

  for (const row of rows) {
    const slug = row[1]; // Column C (slug)
    const folderId = row[3]; // Column E (folder ID)
    if (slug && folderId) {
      map[slug.trim().toLowerCase()] = folderId.trim();
    }
  }

  return map;
}

// Serve frontend per firm
app.get('/upload/:firm', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Handle upload
async function getOrCreateFolder(driveClient, name, parentId) {
  const res = await driveClient.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await driveClient.files.create({
    resource: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  return folder.data.id;
}

app.post('/upload/:firm', upload.array('recordings'), async (req, res) => {
  const firm = req.params.firm.toLowerCase();

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).send('No files were uploaded.');
    }

    const month = req.body.date;
    if (!month) {
      return res.status(400).send('No month selected.');
    }

    const firmMap = await getFirmFolderMap();
    const firmFolderId = firmMap[firm];

    if (!firmFolderId) {
      return res.status(404).send('Firm not found.');
    }

    const driveClient = google.drive({ version: 'v3', auth });

    const callAuditsId = await getOrCreateFolder(driveClient, 'Call Audits', firmFolderId);
    const monthlyRecordingsId = await getOrCreateFolder(driveClient, 'Monthly Recordings', callAuditsId);
    const monthFolderId = await getOrCreateFolder(driveClient, month, monthlyRecordingsId);

    for (const file of req.files) {
      const fileMetadata = {
        name: file.originalname,
        parents: [monthFolderId],
      };
      const media = {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
      };

      await driveClient.files.create({
        resource: fileMetadata,
        media,
        fields: 'id',
        supportsAllDrives: true,
      });

      fs.unlinkSync(file.path);
    }

    res.send('Upload successful.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Upload failed.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));