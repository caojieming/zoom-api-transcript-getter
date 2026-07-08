// helper constants used for setting FROM and TO times
const NOW = new Date().toISOString().split('T')[0]; // Today (YYYY-MM-DD)
const ONE_DAY_AGO = daysAgo(1);
const THREE_DAYS_AGO = daysAgo(3);
const ONE_WEEK_AGO = daysAgo(7);
const ONE_MONTH_AGO = daysAgo(30);
const TWO_MONTHS_AGO = daysAgo(60);
const THREE_MONTHS_AGO = daysAgo(90);
const FOUR_MONTHS_AGO = daysAgo(120);
const FIVE_MONTHS_AGO = daysAgo(150);
const SIX_MONTHS_AGO = daysAgo(180);


// request constants, these are sent to Zoom API as part of the request
// time period of past meetings to GET
const FROM = ONE_MONTH_AGO;
const TO = NOW;
// Type of meeting (meeting or webinar, can also send "" for both)
const MEETING_TYPE = "meeting";
// Optional search query key if you only want meetings with specific word(s) in the topic name
const SEARCH_KEY = "";
// Max meetings per request page (up to 300), used to lower request rate to prevent hitting API rate limits
const PAGE_SIZE = 200;


// extra constants, used for misc filtering
const MEETING_ID = "";

// toggle to include only 4th thursdays of the month
const ONLY_FOURTH_THURS = true;

// the last part of the desired folder link (https://drive.google.com/drive/folders/{DRIVE_FOLDER_ID})
const DRIVE_FOLDER_ID = "";


// can't get more than 1 month worth of records at a time, need to call multiple times
function getTranscriptsRecordingsHalfYear() {
  getTranscriptsRecordings(ONE_MONTH_AGO, NOW);
  getTranscriptsRecordings(TWO_MONTHS_AGO, ONE_MONTH_AGO);
  getTranscriptsRecordings(THREE_MONTHS_AGO, TWO_MONTHS_AGO);
  getTranscriptsRecordings(FOUR_MONTHS_AGO, THREE_MONTHS_AGO);
  getTranscriptsRecordings(FIVE_MONTHS_AGO, FOUR_MONTHS_AGO);
  getTranscriptsRecordings(SIX_MONTHS_AGO, FIVE_MONTHS_AGO);
}


/**
 * Main function to get historical Zoom meetings within the past week,
 * extract transcripts and recordings, and write them into Google drive folder.
 * inFrom: start date of time period observed, defaulting to const FROM
 * inTo: end date of time period observed, defaulting to const TO
 */
function getTranscriptsRecordings(inFrom = FROM, inTo = TO) {
  // Fetch access token using existing client function (assumed to be defined globally)
  const accessToken = getZoomAccessToken();

  var meetings = [];
  var nextMeetingPageToken = "";

  // 1. Paginated fetch of past meetings from the Zoom report API
  do {
    var url = "https://api.zoom.us/v2" + "/report/history_meetings" +
      "?from=" + inFrom +
      "&to=" + inTo +
      "&page_size=" + PAGE_SIZE +
      "&meeting_type=" + MEETING_TYPE;

    if (SEARCH_KEY) {
      url += "&search_key=" + encodeURIComponent(SEARCH_KEY);
    }
    if (nextMeetingPageToken) {
      url += "&next_page_token=" + encodeURIComponent(nextMeetingPageToken);
    }

    var options = {
      method: "get",
      headers: {
        "Authorization": "Bearer " + accessToken
      },
      muteHttpExceptions: true
    };

    // manually write this out because we want custom actions if we get an error (stop paginating)
    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();

    if (responseCode === 200) {
      var data = JSON.parse(response.getContentText());
      // console.log(data);
      if (data.history_meetings && data.history_meetings.length > 0) {
        meetings = meetings.concat(data.history_meetings);
      }
      nextMeetingPageToken = data.next_page_token;
    } else {
      console.error("Error fetching historical meetings. Code: " + responseCode + ", Response: " + response.getContentText());
      nextMeetingPageToken = ""; // Stop pagination on error
    }
  } while (nextMeetingPageToken);


  // Filter for wanted meetings
  var filteredMeetings = [];
  meetings.forEach(function (meeting) {
    var meetingId = meeting.meeting_id;

    // optional check/filter for meeting ID
    // if const MEETING_ID is filled/is not empty AND current meeting ID does not equal const MEETING_ID (note, use soft inequality check: meetingId is apparently not a string)
    if(MEETING_ID !== "" && meetingId != MEETING_ID) {
      return;
    }

    var startTime = meeting.start_time || "";
    // optional check/filter if only looking for meetings on the fourth thursday of the month
    if(ONLY_FOURTH_THURS && !isFourthThursday(startTime)) {
      return;
    }

    // passed all filters, add meeting to filteredMeetings list
    filteredMeetings.push(meeting);
  });


  // 2. Iterate through filtered list of meetings for recordings
  filteredMeetings.forEach(function (meeting) {
    var startTime = meeting.start_time || "";

    var datetime = convertISOTimeZone(startTime);

    const meetingUuid = meeting.meeting_uuid;
    const meetingUuidEncoded = prepareUuid(meetingUuid);

    // GET /meetings/{meetingId}/recordings
    var url = `https://api.zoom.us/v2/meetings/${meetingUuidEncoded}/recordings`;

    const rawData = httpGetData(url, accessToken, convertISOTimeZone(startTime));
    const code = rawData.code;
    const data = JSON.parse(rawData.data);

    // check code from httpGetData
    if(code !== 200) {
      // skip this meeting and continue to the next meeting (error code has already been output to console from httpGetData)
      return;
    }

    // test to see what recordings there are
    // console.log(data.recording_files);

    // loop through all recording_files, searching for file_type = TRANSCRIPT, MP4, CHAT -> place them in drive (see if they can be placed raw or as original files)
    data.recording_files.forEach(function(file) {
      if(file.file_type === "MP4") {
        const fileName = datetime + " [Recording].mp4";
        // Skip if a file with this name already exists in the folder
        if (fileNameExists(DRIVE_FOLDER_ID, fileName)) {
          console.log("File already downloaded: " + fileName);
          return;
        }

        const downloadUrl = file.download_url;
        console.log("Downloading: " + fileName);
        const rawRecording = httpGetBlob(downloadUrl, accessToken);
        const recording = rawRecording.blob;
        recording.setName(fileName + ".mp4");
        console.log("Importing: " + fileName);
        const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
        folder.createFile(recording);
      }
      else if(file.file_type === "TRANSCRIPT") {
        const fileName = datetime + " [Transcript]";
        // Skip if a file with this name already exists in the folder
        if (fileNameExists(DRIVE_FOLDER_ID, fileName)) {
          console.log("File already downloaded: " + fileName);
          return;
        }

        const downloadUrl = file.download_url;
        console.log("Downloading: " + fileName);
        const rawTranscript = httpGetData(downloadUrl, accessToken);
        const transcript = rawTranscript.data;
        // transcript = transcript.replace(/\n{2,}/g, "\n");
        console.log("Importing: " + fileName);
        createGoogleDocInFolder(DRIVE_FOLDER_ID, fileName, transcript);
      }
      else if(file.file_type === "CHAT") {
        const fileName = datetime + " [Recording Chat]";
        // Skip if a file with this name already exists in the folder
        if (fileNameExists(DRIVE_FOLDER_ID, fileName)) {
          console.log("File already downloaded: " + fileName);
          return;
        }

        const downloadUrl = file.download_url;
        console.log("Downloading: " + fileName);
        const rawChat = httpGetData(downloadUrl, accessToken);
        const transcript = rawChat.data;
        console.log("Importing: " + fileName);
        createGoogleDocInFolder(DRIVE_FOLDER_ID, fileName, transcript);
      }
    });

    // small timeout to prevent very specific errors
    // Utilities.sleep(200);
  });
}



// generic get data from a link/API endpoint (use if you don't care for custom error messages/actions)
function httpGetBlob(url, accessToken, id = "") {
  var options = {
    method: "get",
    headers: {
      "Authorization": "Bearer " + accessToken
    },
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const data = res.getContentText();
  const blob = res.getBlob();
  if (code < 200 || code >= 300) {
    // throw new Error(`HTTP code ${code} for ${url}, data: ${data}`);
    console.error(`[${id}]  HTTP code ${code}, data: ${data}`);
  }
  return { code: code, blob: blob };
}

// generic get data from a link/API endpoint (use if you don't care for custom error messages/actions)
function httpGetData(url, accessToken, id = "") {
  var options = {
    method: "get",
    headers: {
      "Authorization": "Bearer " + accessToken
    },
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const data = res.getContentText();
  if (code < 200 || code >= 300) {
    // throw new Error(`HTTP code ${code} for ${url}, data: ${data}`);
    console.error(`[${id}]  HTTP code ${code}, data: ${data}`);
  }
  return { code: code, data: data };
}


// checks if a file/folder with the input name exists
function fileNameExists(folderId, targetName) {
  const folder = DriveApp.getFolderById(folderId);

  // Check files within this folder
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName() === targetName) {
      return true;
    }
  }
  return false;
}


// creates a google doc with a specific name, specific content, and in a specific drive folder
function createGoogleDocInFolder(driveFolderId, docName, docContent) {
  const folder = DriveApp.getFolderById(driveFolderId);

  const doc = DocumentApp.create(docName);
  doc.getBody().setText(docContent);

  const file = DriveApp.getFileById(doc.getId());
  file.moveTo(folder); // puts the file in that folder

  return doc.getId();
}


// check if the input ISO is the 4th thursday in the month
function isFourthThursday(isoDate) {
  const date = new Date(isoDate);
  // Check if the day is Thursday (4)
  if (date.getDay() !== 4) {
      return false;
  }
  const dayOfMonth = date.getDate();
  // Check if the date is between 22 and 28
  return dayOfMonth >= 22 && dayOfMonth <= 28;
}


/**
 * Converts input ISO 8601 (UTC) string into a specified locale string (default PT)
 * iso format: '2023-06-08T18:30:00Z'
 * newTimeZone format: 'America/Los_Angeles'
 */
function convertISOTimeZone(iso, newTimeZone = 'America/Los_Angeles') {
  const dt = new Date(iso);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: newTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).formatToParts(dt);

  const get = (type) => parts.find(p => p.type === type)?.value;

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  const dayPeriod = get('dayPeriod'); // AM/PM

  return `${year}/${month}/${day}, ${hour}:${minute}:${second} ${dayPeriod}`;
}


/**
 * Prepares the Zoom Meeting UUID for use in URL paths, applying double-encoding
 * if the UUID contains a forward slash or begins with one.
 * @param {string} uuid - The raw Zoom UUID.
 * @returns {string} The URL encoded UUID.
 */
function prepareUuid(uuid) {
  if (!uuid) return "";
  if (uuid.indexOf('/') !== -1 || uuid.startsWith('/')) {
    return encodeURIComponent(encodeURIComponent(uuid));
  }
  return encodeURIComponent(uuid);
}


// a simple function to get the datetime "days" ago
function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}
