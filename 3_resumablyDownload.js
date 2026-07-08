// this file is for a large helper function used in 2_getRecordings.gs
// specifically, it allows downloading blobs larger than the 50mb limit of Apps Script

// some size that's under 50mb (tune down if getting "Out of memory error.", otherwise don't touch)
// Note: 24 is the highest value I've tested that doesn't get memory errors
const MEGABYTE = 1024 * 1024;
const CHUNK_BYTES = 20 * MEGABYTE;

// DRIVE_FOLDER_ID already declared in 2_*.gs

function resumablyDownload(oauthToken, zoomDownloadLink, fileSize, fileName) {
  const props = PropertiesService.getScriptProperties();
  const mimeType = 'video/mp4';

  let sessionUri = props.getProperty('sessionUri');
  let nextStart = Number(props.getProperty('nextStart') || '0');

  if (!sessionUri) {
    sessionUri = createResumableSession(fileName, mimeType, fileSize, DRIVE_FOLDER_ID);
    props.setProperty('sessionUri', sessionUri);
    props.setProperty('nextStart', String(0));
    nextStart = 0;
  }

  for (let start = nextStart; start < fileSize; start += CHUNK_BYTES) {
    const end = Math.min(fileSize - 1, start + CHUNK_BYTES - 1);

    const chunk = downloadRange(zoomDownloadLink, oauthToken, start, end);
    uploadChunk(sessionUri, chunk, start, end, fileSize);

    props.setProperty('nextStart', String(end + 1));

    Logger.log(`Uploaded megabytes ${round2Decimals(end/MEGABYTE)} / ${round2Decimals(fileSize/MEGABYTE)}}`);
  }

  // finished
  props.deleteProperty('sessionUri');
  props.deleteProperty('nextStart');
  Logger.log('Finished Uploading!');
}


function createResumableSession(fileName, mimeType, totalBytes, folderId) {
  const metadata = {
    name: fileName,
    mimeType: mimeType,
    parents: [folderId]
  };

  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(totalBytes),
      'X-Upload-Content-Type': mimeType
    },
    payload: JSON.stringify(metadata),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Failed to start resumable session: ' + res.getContentText());
  }

  const headers = res.getAllHeaders();
  const sessionUri = headers.Location || headers.location;
  if (!sessionUri) throw new Error('Missing Location header for resumable session.');

  return sessionUri;
}

function downloadRange(downloadUrl, oauthToken, start, end) {
  // Zoom download_url usually works with redirects; follow them.
  // If your Zoom download_url *does not* accept the OAuth token on Range requests,
  // remove Authorization header here and rely on the signed download_url.
  const res = UrlFetchApp.fetch(downloadUrl, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + oauthToken,
      Range: `bytes=${start}-${end}`
    },
    followRedirects: true,
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  // Expect 206 Partial Content
  if (code !== 206 && code !== 200) {
    throw new Error(`Chunk download failed (${code}) bytes=${start}-${end}: ${res.getContentText()}`);
  }

  return res.getContent(); // binary chunk
}

function uploadChunk(sessionUri, chunk, start, end, totalBytes) {
  // const contentLength = end - start + 1;

  const resp = UrlFetchApp.fetch(sessionUri, {
    method: 'PUT',
    headers: {
      // 'Content-Length': String(contentLength),
      'Content-Range': `bytes ${start}-${end}/${totalBytes}`
    },
    payload: chunk,
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  // 308 = resume incomplete, 200/201 = complete
  if (code !== 200 && code !== 201 && code !== 308) {
    throw new Error(`Chunk upload failed (${code}) bytes=${start}-${end}: ${resp.getContentText()}`);
  }
}

function round2Decimals(num) {
  return Math.trunc(num*100)/100;
}
