// helper constants used for setting FROM and TO times
const NOW = new Date().toISOString().split('T')[0]; // Today (YYYY-MM-DD)
const ONE_DAY_AGO = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const THREE_DAYS_AGO = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const ONE_WEEK_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // One week ago (YYYY-MM-DD)
const ONE_MONTH_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const TWO_MONTHS_AGO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const THREE_MONTHS_AGO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const FOUR_MONTHS_AGO = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const FIVE_MONTHS_AGO = new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const SIX_MONTHS_AGO = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];


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


const DRIVE_FOLDER_ID = "";


// can't get more than 1 month worth of records at a time, need to call multiple times
function getTranscriptsHalfYear() {
  getTranscripts(ONE_MONTH_AGO, NOW);
  getTranscripts(TWO_MONTHS_AGO, ONE_MONTH_AGO);
  getTranscripts(THREE_MONTHS_AGO, TWO_MONTHS_AGO);
  getTranscripts(FOUR_MONTHS_AGO, THREE_MONTHS_AGO);
  getTranscripts(FIVE_MONTHS_AGO, FOUR_MONTHS_AGO);
  getTranscripts(SIX_MONTHS_AGO, FIVE_MONTHS_AGO);
}


/**
 * Main function to get historical Zoom meetings within the past week,
 * extract details and participant lists, and write them into Google Sheets.
 * inFrom: start date of time period observed, defaulting to const FROM
 * inTo: end date of time period observed, defaulting to const TO
 */
function getTranscripts(inFrom = FROM, inTo = TO) {
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


  // Filter for unique meetings based on UUID
  var uniqueMeetings = [];
  var seenUuids = new Set();
  meetings.forEach(function (meeting) {
    if (meeting.meeting_uuid && !seenUuids.has(meeting.meeting_uuid)) {
      seenUuids.add(meeting.meeting_uuid);
      uniqueMeetings.push(meeting);
    }
  });


  // 2. Iterate through each unique meeting and build the spreadsheets
  uniqueMeetings.forEach(function (meeting) {
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

    var docName = convertISOTimeZone(startTime);
    // Skip if a doc with this name already exists
    if (docNameAlreadyExists(DRIVE_FOLDER_ID, docName)) {
      return;
    }

    const meetingUuid = meeting.meeting_uuid;
    const meetingUuidEncoded = prepareUuid(meetingUuid);

    // GET /meetings/{meetingId}/transcript
    var url = `https://api.zoom.us/v2/meetings/${meetingUuidEncoded}/transcript`;

    const rawData = httpGetData(url, accessToken);
    var data = JSON.parse(rawData);

    // check if the transcript is available/downloadable from the meeting
    if(data.can_download !== true) {
      console.error("Transcript not downloadable: " + data.download_restriction_reason);
      // skip this meeting and continue to the next meeting
      return;
    }

    // get download url
    const downloadUrl = data.download_url;
    // if(!downloadUrl) {
    //   console.error("Download URL empty.");
    //   // skip this meeting and continue to the next meeting
    //   return;
    // }

    // this is the transcript, ready to go
    const transcript = httpGetData(downloadUrl, accessToken);

    // create a google doc with the transcript
    createGoogleDocInFolder(DRIVE_FOLDER_ID, docName, transcript);
  });
}



// generic get data from a link/API endpoint (use if you don't care for custom error messages/actions)
function httpGetData(url, accessToken) {
  var options = {
    method: "get",
    headers: {
      "Authorization": "Bearer " + accessToken
    },
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const rawData = res.getContentText();
  if (code < 200 || code >= 300) {
    // throw new Error(`HTTP code ${code} for ${url}, data: ${rawData}`);
    console.error(`HTTP code ${code} for ${url}, data: ${rawData}`);
  }
  return rawData;
}


// checks if a doc with the input name exists
function docNameAlreadyExists(folderId, targetName) {
  const folder = DriveApp.getFolderById(folderId);

  // Check only within this folder (not subfolders)
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
  const converted = dt.toLocaleString('en-US', { timeZone: newTimeZone,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: true });
  return converted; // e.g. "06/08/2023, 11:30:00 AM"
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
