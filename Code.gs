/**
 * ระบบปฏิทินกิจกรรม มจร กาฬสินธุ์
 * หน่วยวิทยบริการ วิทยาลัยสงฆ์ขอนแก่น จังหวัดกาฬสินธุ์
 * ผู้พัฒนา: พระมหาธงชัย วิลาสินี
 */

const APP = Object.freeze({
  VERSION: '2026.07.06-ICON7-BOOTREADY',
  SPREADSHEET_ID: '1yEPimKgNNLYJdpGxQa8axrIMroWOEFFArt-8-9SpHkg',
  FOLDER_ID: '13giqzIvwPj5MeHVJFZnW8FOHywDFc2rZ',
  TIMEZONE: 'Asia/Bangkok',
  SHEETS: {
    ACTIVITIES: 'กิจกรรม',
    CENTRAL: 'ปฏิทินกลาง',
    SETTINGS: 'ตั้งค่าระบบ',
    OPTIONS: 'รายการตัวเลือก',
    LOGS: 'บันทึกระบบ',
    IMPORTS: 'ประวัตินำเข้า',
    ICONS: 'ตั้งค่าไอคอน'
  },
  ACTIVITY_START_ROW: 3,
  CENTRAL_START_ROW: 3,
  SETTINGS_START_ROW: 3,
  IMPORTS_START_ROW: 3,
  CENTRAL_COLUMNS: 16,
  IMPORT_HISTORY_COLUMNS: 15,
  TOKEN_TTL_SECONDS: 21600,
  DEFAULT_ADMIN_PASSWORD: 'admin1234',
  MAX_ICS_BYTES: 5 * 1024 * 1024,
  MAX_IMPORT_ITEMS: 600,
  MYHORA_URLS: {
    buddhist: 'https://myhora.com/calendar/ical/buddha.aspx?latest.ics=',
    holiday: 'https://myhora.com/calendar/ical/holiday.aspx?latest.ics=',
    lunar: 'https://myhora.com/calendar/ical/thai.aspx?latest.ics='
  }
});

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('ระบบปฏิทินกิจกรรม มจร กาฬสินธุ์')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** ใช้เรียกครั้งแรกจาก Apps Script Editor ได้เช่นกัน */
function setupSystem() {
  setupSystem_();
  return { status: 'success', message: 'ตรวจสอบและเตรียมโครงสร้างระบบเรียบร้อยแล้ว' };
}

function setupSystem_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_();
    ss.setSpreadsheetTimeZone(APP.TIMEZONE);
    validateSystemStructure_(ss);

    const props = PropertiesService.getScriptProperties();
    const schemaVersion = APP.VERSION;
    const importSheetMissing = !ss.getSheetByName(APP.SHEETS.IMPORTS);
    const iconSheetMissing = !ss.getSheetByName(APP.SHEETS.ICONS);
    const centralNeedsIconColumn = ss.getSheetByName(APP.SHEETS.CENTRAL).getMaxColumns() < APP.CENTRAL_COLUMNS;
    if (props.getProperty('SCHEMA_VERSION') !== schemaVersion || importSheetMissing || iconSheetMissing || centralNeedsIconColumn) {
      ensureIconSettingsSheet_(ss);
      ensureCentralImportColumns_(ss.getSheetByName(APP.SHEETS.CENTRAL));
      ensureImportHistorySheet_(ss);
      ensureImportOptions_(ss.getSheetByName(APP.SHEETS.OPTIONS));
      ensureImportSettings_(ss.getSheetByName(APP.SHEETS.SETTINGS));
      props.setProperty('SCHEMA_VERSION', schemaVersion);
    }

    if (!props.getProperty('ADMIN_PASSWORD_HASH')) {
      props.setProperty('ADMIN_PASSWORD_HASH', hashPassword_(APP.DEFAULT_ADMIN_PASSWORD));
    }
  } finally {
    lock.releaseLock();
  }
}

function validateSystemStructure_(ss) {
  const coreSheets = [
    APP.SHEETS.ACTIVITIES,
    APP.SHEETS.CENTRAL,
    APP.SHEETS.SETTINGS,
    APP.SHEETS.OPTIONS,
    APP.SHEETS.LOGS
  ];
  const existing = ss.getSheets().map(function(sheet) { return sheet.getName(); });
  const missingCore = coreSheets.filter(function(name) { return existing.indexOf(name) === -1; });
  if (missingCore.length) {
    throw new Error('ไม่พบชีตที่จำเป็น: ' + missingCore.join(', ') + ' กรุณาตรวจสอบ Spreadsheet ID และโครงสร้างชีต');
  }
}

function getBootstrapData() {
  const startedAt = Date.now();
  try {
    const ss = getSpreadsheet_();
    validateSystemStructure_(ss);

    const settings = getSettings_(ss);
    const options = getOptions_(ss);
    const iconSettings = getIconSettings_(ss);
    const activities = getActivities_(ss);
    const centralCalendar = getCentralCalendar_(ss);

    return success_({
      settings: settings,
      options: options,
      activities: activities,
      centralCalendar: centralCalendar,
      iconSettings: iconSettings,
      serverDate: Utilities.formatDate(new Date(), APP.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"),
      spreadsheetUrl: ss.getUrl(),
      appVersion: APP.VERSION,
      serverElapsedMs: Date.now() - startedAt
    });
  } catch (err) {
    return failure_(err);
  }
}

function refreshData() {
  return getBootstrapData();
}

function healthCheck() {
  try {
    const ss = getSpreadsheet_();
    validateSystemStructure_(ss);
    return success_({
      version: APP.VERSION,
      spreadsheetName: ss.getName(),
      timezone: ss.getSpreadsheetTimeZone(),
      centralRows: ss.getSheetByName(APP.SHEETS.CENTRAL).getLastRow(),
      iconRows: ss.getSheetByName(APP.SHEETS.ICONS) ? ss.getSheetByName(APP.SHEETS.ICONS).getLastRow() : 0
    });
  } catch (err) {
    return failure_(err);
  }
}

/* =========================
   AUTHENTICATION
========================= */

function loginAdmin(password) {
  try {
    const entered = String(password || '');
    const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD_HASH');
    if (!entered || hashPassword_(entered) !== stored) {
      logAction_('ผู้ใช้งานไม่ระบุ', 'เข้าสู่ระบบไม่สำเร็จ', 'รหัสผ่านไม่ถูกต้อง', 'AUTH');
      return { status: 'error', message: 'รหัสผ่านผู้ดูแลระบบไม่ถูกต้อง' };
    }

    const token = Utilities.getUuid();
    CacheService.getScriptCache().put('ADMIN_TOKEN_' + token, '1', APP.TOKEN_TTL_SECONDS);
    logAction_('ผู้ดูแลระบบ', 'เข้าสู่ระบบ', 'เข้าสู่ระบบผู้ดูแลสำเร็จ', 'AUTH');
    return success_({ token: token, expiresIn: APP.TOKEN_TTL_SECONDS });
  } catch (err) {
    return failure_(err);
  }
}

function logoutAdmin(token) {
  try {
    if (token) CacheService.getScriptCache().remove('ADMIN_TOKEN_' + token);
    logAction_('ผู้ดูแลระบบ', 'ออกจากระบบ', 'ออกจากระบบผู้ดูแล', 'AUTH');
    return success_();
  } catch (err) {
    return failure_(err);
  }
}

function validateAdminToken(token) {
  return { status: isValidToken_(token) ? 'success' : 'error' };
}

function changeAdminPassword(token, oldPassword, newPassword) {
  try {
    requireAdmin_(token);
    const props = PropertiesService.getScriptProperties();
    const stored = props.getProperty('ADMIN_PASSWORD_HASH');
    if (hashPassword_(String(oldPassword || '')) !== stored) {
      throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
    }
    const next = String(newPassword || '');
    if (next.length < 8) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
    props.setProperty('ADMIN_PASSWORD_HASH', hashPassword_(next));
    logAction_('ผู้ดูแลระบบ', 'เปลี่ยนรหัสผ่าน', 'เปลี่ยนรหัสผ่านผู้ดูแลระบบ', 'AUTH');
    return success_({ message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
  } catch (err) {
    return failure_(err);
  }
}

/* =========================
   ACTIVITIES CRUD
========================= */

function saveActivity(token, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    payload = payload || {};
    validateActivityPayload_(payload);

    const sheet = getSheet_(APP.SHEETS.ACTIVITIES);
    const now = new Date();
    const startDate = parseClientDate_(payload.startDate);
    const endDate = parseClientDate_(payload.endDate || payload.startDate);
    if (endDate.getTime() < startDate.getTime()) {
      throw new Error('วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่ม');
    }

    const isEdit = String(payload.mode || '').toLowerCase() === 'edit';
    let id = String(payload.id || '').trim();
    let rowNumber = Number(payload.rowNumber || 0);
    let createdAt = now;

    if (isEdit) {
      rowNumber = findActivityRow_(sheet, id, rowNumber);
      if (!rowNumber) throw new Error('ไม่พบกิจกรรมที่ต้องการแก้ไข');
      createdAt = sheet.getRange(rowNumber, 13).getValue() || now;
    } else {
      id = createActivityId_();
      rowNumber = Math.max(sheet.getLastRow() + 1, APP.ACTIVITY_START_ROW);
    }

    const row = [[
      id,
      startDate,
      endDate,
      cleanText_(payload.title),
      cleanText_(payload.type || 'อื่นๆ'),
      cleanText_(payload.owner),
      cleanText_(payload.related),
      cleanText_(payload.location),
      cleanText_(payload.description),
      cleanText_(payload.status || 'รอดำเนินการ'),
      cleanText_(payload.color || '#8F1D54'),
      cleanText_(payload.attachmentUrl),
      createdAt,
      now
    ]];

    sheet.getRange(rowNumber, 1, 1, 14).setValues(row);
    sheet.getRange(rowNumber, 2, 1, 2).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(rowNumber, 13, 1, 2).setNumberFormat('dd/MM/yyyy HH:mm');

    logAction_('ผู้ดูแลระบบ', isEdit ? 'แก้ไขกิจกรรม' : 'เพิ่มกิจกรรม', payload.title, id);
    return success_({ activity: mapActivityRow_(row[0], rowNumber) });
  } catch (err) {
    return failure_(err);
  } finally {
    lock.releaseLock();
  }
}

function deleteActivity(token, id, rowNumber) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    const sheet = getSheet_(APP.SHEETS.ACTIVITIES);
    const row = findActivityRow_(sheet, String(id || ''), Number(rowNumber || 0));
    if (!row) throw new Error('ไม่พบกิจกรรมที่ต้องการลบ');
    const title = sheet.getRange(row, 4).getDisplayValue();
    sheet.deleteRow(row);
    logAction_('ผู้ดูแลระบบ', 'ลบกิจกรรม', title, id);
    return success_();
  } catch (err) {
    return failure_(err);
  } finally {
    lock.releaseLock();
  }
}

function updateActivityStatus(token, id, rowNumber, status) {
  try {
    requireAdmin_(token);
    const sheet = getSheet_(APP.SHEETS.ACTIVITIES);
    const row = findActivityRow_(sheet, String(id || ''), Number(rowNumber || 0));
    if (!row) throw new Error('ไม่พบกิจกรรม');
    sheet.getRange(row, 10).setValue(cleanText_(status));
    sheet.getRange(row, 14).setValue(new Date()).setNumberFormat('dd/MM/yyyy HH:mm');
    logAction_('ผู้ดูแลระบบ', 'เปลี่ยนสถานะกิจกรรม', status, id);
    return success_();
  } catch (err) {
    return failure_(err);
  }
}

/* =========================
   CENTRAL CALENDAR CRUD
========================= */

function saveCentralItem(token, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    payload = payload || {};
    if (!payload.date) throw new Error('กรุณาระบุวันที่');
    if (!payload.type) throw new Error('กรุณาระบุประเภทข้อมูล');

    const sheet = getSheet_(APP.SHEETS.CENTRAL);
    const mode = String(payload.mode || '').toLowerCase();
    let rowNumber = Number(payload.rowNumber || 0);
    let importMeta = ['', '', '', ''];
    let existingIconKey = '';
    if (mode === 'edit') {
      if (rowNumber < APP.CENTRAL_START_ROW || rowNumber > sheet.getLastRow()) {
        throw new Error('ไม่พบข้อมูลปฏิทินกลางที่ต้องการแก้ไข');
      }
      const storedMeta = sheet.getRange(rowNumber, 12, 1, 5).getValues()[0];
      importMeta = storedMeta.slice(0, 4);
      existingIconKey = String(storedMeta[4] || '');
    } else {
      rowNumber = Math.max(sheet.getLastRow() + 1, APP.CENTRAL_START_ROW);
    }

    const row = [[
      parseClientDate_(payload.date),
      cleanText_(payload.lunar),
      toBoolean_(payload.isBuddhistDay),
      cleanText_(payload.type),
      cleanText_(payload.title),
      toBoolean_(payload.isHoliday),
      cleanText_(payload.source || 'ปฏิทินส่วนกลาง มจร.'),
      cleanText_(payload.note),
      cleanText_(payload.visibility || 'แสดง'),
      cleanText_(payload.color || '#D5A62E'),
      Number(payload.displayOrder || 10),
      cleanText_(payload.importUid || importMeta[0]),
      cleanText_(payload.importBatchId || importMeta[1]),
      payload.importedAt ? new Date(payload.importedAt) : (importMeta[2] || ''),
      cleanText_(payload.sourceUrl || importMeta[3]),
      cleanText_(Object.prototype.hasOwnProperty.call(payload, 'iconKey') ? payload.iconKey : existingIconKey)
    ]];

    sheet.getRange(rowNumber, 1, 1, APP.CENTRAL_COLUMNS).setValues(row);
    sheet.getRange(rowNumber, 1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(rowNumber, 14).setNumberFormat('dd/MM/yyyy HH:mm');
    logAction_('ผู้ดูแลระบบ', mode === 'edit' ? 'แก้ไขปฏิทินกลาง' : 'เพิ่มปฏิทินกลาง', payload.title || payload.type, 'CENTRAL-' + rowNumber);
    return success_({ centralItem: mapCentralRow_(row[0], rowNumber) });
  } catch (err) {
    return failure_(err);
  } finally {
    lock.releaseLock();
  }
}

function deleteCentralItem(token, rowNumber) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    const sheet = getSheet_(APP.SHEETS.CENTRAL);
    const row = Number(rowNumber || 0);
    if (row < APP.CENTRAL_START_ROW || row > sheet.getLastRow()) throw new Error('ไม่พบข้อมูลที่ต้องการลบ');
    const title = sheet.getRange(row, 5).getDisplayValue() || sheet.getRange(row, 4).getDisplayValue();
    sheet.deleteRow(row);
    logAction_('ผู้ดูแลระบบ', 'ลบปฏิทินกลาง', title, 'CENTRAL-' + row);
    return success_();
  } catch (err) {
    return failure_(err);
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   SETTINGS
========================= */

function saveSettings(token, updates) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    updates = updates || {};
    const allowed = [
      'SYSTEM_NAME', 'UNIVERSITY_NAME', 'ORGANIZATION', 'LOCATION', 'ACADEMIC_YEAR',
      'LOGO_URL', 'WEBSITE', 'CONTACT_PHONE', 'DEVELOPER', 'DEVELOPER_POSITION',
      'THEME_PRIMARY', 'THEME_SECONDARY', 'THEME_GOLD', 'THEME_BACKGROUND',
      'SHOW_LUNAR', 'SHOW_BUDDHIST_DAY', 'SHOW_HOLIDAY',
      'MYHORA_BUDDHIST_URL', 'MYHORA_HOLIDAY_URL', 'MYHORA_LUNAR_URL'
    ];
    const sheet = getSheet_(APP.SHEETS.SETTINGS);
    const lastRow = Math.max(sheet.getLastRow(), APP.SETTINGS_START_ROW);
    const values = sheet.getRange(APP.SETTINGS_START_ROW, 1, lastRow - APP.SETTINGS_START_ROW + 1, 2).getValues();
    const rowMap = {};
    values.forEach((row, index) => {
      const key = String(row[0] || '').trim();
      if (key) rowMap[key] = APP.SETTINGS_START_ROW + index;
    });

    allowed.forEach(key => {
      if (!(key in updates)) return;
      const row = rowMap[key];
      if (!row) return;
      const value = key.indexOf('SHOW_') === 0 ? toBoolean_(updates[key]) : cleanText_(updates[key]);
      sheet.getRange(row, 2).setValue(value);
    });

    logAction_('ผู้ดูแลระบบ', 'บันทึกการตั้งค่า', 'ปรับปรุงการตั้งค่าระบบ', 'SETTINGS');
    return success_({ settings: getSettings_() });
  } catch (err) {
    return failure_(err);
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   FILE UPLOAD
========================= */

function uploadAttachment(token, fileData) {
  try {
    requireAdmin_(token);
    if (!fileData || !fileData.base64 || !fileData.name) throw new Error('ไม่พบไฟล์สำหรับอัปโหลด');
    const maxBytes = 10 * 1024 * 1024;
    const bytes = Utilities.base64Decode(String(fileData.base64));
    if (bytes.length > maxBytes) throw new Error('ไฟล์มีขนาดเกิน 10 MB');

    const folder = DriveApp.getFolderById(APP.FOLDER_ID);
    const safeName = sanitizeFilename_(fileData.name);
    const blob = Utilities.newBlob(bytes, fileData.mimeType || 'application/octet-stream', safeName);
    const file = folder.createFile(blob);
    file.setDescription('ไฟล์แนบจากระบบปฏิทินกิจกรรม มจร กาฬสินธุ์');
    const url = file.getUrl();
    logAction_('ผู้ดูแลระบบ', 'อัปโหลดไฟล์', safeName, file.getId());
    return success_({ url: url, fileId: file.getId(), name: safeName });
  } catch (err) {
    return failure_(err);
  }
}

/* =========================
   ICS / MYHORA IMPORT
========================= */

function previewIcsFromUrl(token, url, options) {
  try {
    requireAdmin_(token);
    const safeUrl = validateMyHoraUrl_(url);
    const response = UrlFetchApp.fetch(safeUrl, {
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      validateHttpsCertificates: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 MCU-Kalasin-Calendar/1.0',
        'Accept': 'text/calendar,text/plain,*/*'
      }
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error('ไม่สามารถดาวน์โหลดไฟล์ปฏิทินได้ (HTTP ' + code + ')');
    }
    const blob = response.getBlob();
    if (blob.getBytes().length > APP.MAX_ICS_BYTES) throw new Error('ไฟล์ปฏิทินมีขนาดเกิน 5 MB');
    const text = blob.getDataAsString('UTF-8');
    return success_(analyzeIcsText_(text, options || {}, {
      sourceUrl: safeUrl,
      sourceName: safeUrl
    }));
  } catch (err) {
    return failure_(err);
  }
}

function previewIcsFile(token, fileData, options) {
  try {
    requireAdmin_(token);
    if (!fileData || !fileData.base64 || !fileData.name) throw new Error('กรุณาเลือกไฟล์ ICS');
    const name = String(fileData.name || 'calendar.ics');
    if (!/\.(ics|ical|ifb|icalendar|txt)$/i.test(name)) {
      throw new Error('รองรับไฟล์ .ics, .ical, .ifb, .icalendar และ .txt เท่านั้น');
    }
    const bytes = Utilities.base64Decode(String(fileData.base64));
    if (bytes.length > APP.MAX_ICS_BYTES) throw new Error('ไฟล์ปฏิทินมีขนาดเกิน 5 MB');
    const text = Utilities.newBlob(bytes, fileData.mimeType || 'text/calendar', name).getDataAsString('UTF-8');
    return success_(analyzeIcsText_(text, options || {}, {
      sourceUrl: '',
      sourceName: name
    }));
  } catch (err) {
    return failure_(err);
  }
}

function commitIcsImport(token, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    payload = payload || {};
    const items = Array.isArray(payload.items) ? payload.items.filter(function(item) { return item && item.selected !== false; }) : [];
    if (!items.length) throw new Error('ไม่มีรายการที่เลือกสำหรับนำเข้า');
    if (items.length > APP.MAX_IMPORT_ITEMS) throw new Error('นำเข้าได้ไม่เกิน ' + APP.MAX_IMPORT_ITEMS + ' รายการต่อครั้ง');

    const strategy = ['skip', 'update'].indexOf(String(payload.strategy || 'skip')) >= 0 ? String(payload.strategy || 'skip') : 'skip';
    const meta = payload.meta || {};
    const sheet = getSheet_(APP.SHEETS.CENTRAL);
    ensureCentralImportColumns_(sheet);
    const batchId = createImportBatchId_();
    const now = new Date();
    const existingRows = readCentralRowsForImport_(sheet);
    const indexes = buildCentralIndexes_(existingRows);
    const backup = {
      batchId: batchId,
      createdAt: now.toISOString(),
      addedUids: [],
      updated: []
    };
    const appendRows = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let conflicts = 0;

    items.forEach(function(rawItem) {
      const item = normalizeImportItem_(rawItem, batchId, now, meta);
      const uidKey = item[11] ? String(item[11]) : '';
      const logicalKey = makeCentralLogicalKey_(item[0], item[3], item[4]);
      let existing = uidKey && indexes.byUid[uidKey] ? indexes.byUid[uidKey] : indexes.byKey[logicalKey];

      if (existing) {
        if (strategy === 'skip') {
          skipped++;
          return;
        }
        const existingSource = String(existing.values[6] || '');
        const existingUid = String(existing.values[11] || '');
        if (existingSource.indexOf('MyHora') === -1 && (!uidKey || existingUid !== uidKey)) {
          conflicts++;
          skipped++;
          return;
        }
        backup.updated.push({
          uid: existingUid,
          key: makeCentralLogicalKey_(existing.values[0], existing.values[3], existing.values[4]),
          original: serializeSheetRow_(existing.values)
        });
        sheet.getRange(existing.rowNumber, 1, 1, APP.CENTRAL_COLUMNS).setValues([item]);
        updated++;
        indexes.byUid[uidKey] = { rowNumber: existing.rowNumber, values: item };
        indexes.byKey[logicalKey] = { rowNumber: existing.rowNumber, values: item };
      } else {
        appendRows.push(item);
        backup.addedUids.push(uidKey || logicalKey);
        added++;
      }
    });

    if (appendRows.length) {
      const startRow = Math.max(sheet.getLastRow() + 1, APP.CENTRAL_START_ROW);
      sheet.getRange(startRow, 1, appendRows.length, APP.CENTRAL_COLUMNS).setValues(appendRows);
      sheet.getRange(startRow, 1, appendRows.length, 1).setNumberFormat('dd/MM/yyyy');
      sheet.getRange(startRow, 14, appendRows.length, 1).setNumberFormat('dd/MM/yyyy HH:mm');
    }

    const backupFile = saveImportBackup_(backup);
    writeImportHistory_({
      batchId: batchId,
      date: now,
      sourceType: cleanText_(meta.sourceType || payload.sourceType || 'auto'),
      buddhistYear: Number(meta.buddhistYear || payload.buddhistYear || 0),
      sourceLabel: cleanText_(meta.calendarName || meta.sourceLabel || 'MyHora'),
      sourceLocation: cleanText_(meta.sourceUrl || meta.sourceName || ''),
      selected: items.length,
      added: added,
      updated: updated,
      skipped: skipped,
      errors: conflicts,
      strategy: strategy,
      status: 'สำเร็จ',
      backupFileId: backupFile.getId(),
      user: 'ผู้ดูแลระบบ'
    });

    logAction_('ผู้ดูแลระบบ', 'นำเข้าปฏิทิน ICS', 'เพิ่ม ' + added + ' อัปเดต ' + updated + ' ข้าม ' + skipped, batchId);
    return success_({
      batchId: batchId,
      added: added,
      updated: updated,
      skipped: skipped,
      conflicts: conflicts,
      total: items.length
    });
  } catch (err) {
    return failure_(err);
  } finally {
    lock.releaseLock();
  }
}

function getImportHistory(token, limit) {
  try {
    requireAdmin_(token);
    const sheet = getSheet_(APP.SHEETS.IMPORTS);
    const lastRow = sheet.getLastRow();
    if (lastRow < APP.IMPORTS_START_ROW) return success_({ history: [] });
    const count = Math.min(Math.max(Number(limit || 100), 1), 300);
    const startRow = Math.max(APP.IMPORTS_START_ROW, lastRow - count + 1);
    const rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, APP.IMPORT_HISTORY_COLUMNS).getDisplayValues().reverse();
    const history = rows.map(function(row, index) {
      return {
        rowNumber: lastRow - index,
        batchId: row[0],
        dateTime: row[1],
        sourceType: row[2],
        buddhistYear: row[3],
        sourceLabel: row[4],
        sourceLocation: row[5],
        selected: row[6],
        added: row[7],
        updated: row[8],
        skipped: row[9],
        errors: row[10],
        strategy: row[11],
        status: row[12],
        backupFileId: row[13],
        user: row[14]
      };
    });
    return success_({ history: history });
  } catch (err) {
    return failure_(err);
  }
}

function rollbackIcsImport(token, batchId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    const historySheet = getSheet_(APP.SHEETS.IMPORTS);
    const historyRow = findImportHistoryRow_(historySheet, batchId);
    if (!historyRow) throw new Error('ไม่พบประวัติการนำเข้าที่ต้องการย้อนกลับ');
    const status = String(historySheet.getRange(historyRow, 13).getValue() || '');
    if (status === 'ย้อนกลับแล้ว') throw new Error('รายการนำเข้านี้ถูกย้อนกลับแล้ว');
    const backupFileId = String(historySheet.getRange(historyRow, 14).getValue() || '');
    if (!backupFileId) throw new Error('ไม่พบไฟล์สำรองสำหรับย้อนกลับ');

    const backupText = DriveApp.getFileById(backupFileId).getBlob().getDataAsString('UTF-8');
    const backup = JSON.parse(backupText);
    const sheet = getSheet_(APP.SHEETS.CENTRAL);
    const lastRow = sheet.getLastRow();
    if (lastRow >= APP.CENTRAL_START_ROW) {
      const values = sheet.getRange(APP.CENTRAL_START_ROW, 1, lastRow - APP.CENTRAL_START_ROW + 1, APP.CENTRAL_COLUMNS).getValues();
      const rowsToDelete = [];
      values.forEach(function(row, index) {
        const rowNumber = APP.CENTRAL_START_ROW + index;
        const uid = String(row[11] || '');
        const logicalKey = makeCentralLogicalKey_(row[0], row[3], row[4]);
        if (String(row[12] || '') === String(batchId) && backup.addedUids.indexOf(uid || logicalKey) >= 0) {
          rowsToDelete.push(rowNumber);
        }
      });
      rowsToDelete.sort(function(a, b) { return b - a; }).forEach(function(rowNumber) { sheet.deleteRow(rowNumber); });
    }

    (backup.updated || []).forEach(function(record) {
      const currentRows = readCentralRowsForImport_(sheet);
      const idx = buildCentralIndexes_(currentRows);
      const found = (record.uid && idx.byUid[record.uid]) || idx.byKey[record.key];
      const original = padSheetRow_(deserializeSheetRow_(record.original), APP.CENTRAL_COLUMNS);
      if (found) {
        sheet.getRange(found.rowNumber, 1, 1, APP.CENTRAL_COLUMNS).setValues([original]);
      } else {
        const targetRow = Math.max(sheet.getLastRow() + 1, APP.CENTRAL_START_ROW);
        sheet.getRange(targetRow, 1, 1, APP.CENTRAL_COLUMNS).setValues([original]);
      }
    });

    historySheet.getRange(historyRow, 13).setValue('ย้อนกลับแล้ว');
    logAction_('ผู้ดูแลระบบ', 'ย้อนกลับการนำเข้า ICS', 'ย้อนกลับชุดข้อมูล ' + batchId, batchId);
    return success_({ message: 'ย้อนกลับข้อมูลนำเข้าเรียบร้อยแล้ว' });
  } catch (err) {
    return failure_(err);
  } finally {
    lock.releaseLock();
  }
}

function analyzeIcsText_(text, options, sourceMeta) {
  const rawText = String(text || '').replace(/^\uFEFF/, '');
  if (rawText.indexOf('BEGIN:VCALENDAR') === -1 || rawText.indexOf('BEGIN:VEVENT') === -1) {
    throw new Error('ไฟล์ไม่ใช่ข้อมูล iCalendar ที่ถูกต้อง');
  }
  const parsed = parseIcsDocument_(rawText);
  const sourceType = resolveIcsSourceType_(options.sourceType, parsed.calendarName, sourceMeta.sourceName, parsed.events);
  const buddhistYear = Number(options.buddhistYear || new Date().getFullYear() + 543);
  const gregorianYear = buddhistYear > 2400 ? buddhistYear - 543 : buddhistYear;
  const convertDigits = options.convertThaiDigits !== false;
  const markHoliday = options.markHoliday !== false;
  const existingIndex = buildCentralIndexes_(readCentralRowsForImport_(getSheet_(APP.SHEETS.CENTRAL)));
  const items = [];

  parsed.events.forEach(function(event) {
    const dateKey = parseIcsDateKey_(event.DTSTART || '');
    if (!dateKey || Number(dateKey.slice(0, 4)) !== gregorianYear) return;
    const item = makeImportPreviewItem_(event, sourceType, {
      buddhistYear: buddhistYear,
      convertDigits: convertDigits,
      markHoliday: markHoliday,
      sourceUrl: sourceMeta.sourceUrl || '',
      sourceName: sourceMeta.sourceName || '',
      calendarName: parsed.calendarName || ''
    });
    const uidMatch = item.importUid && existingIndex.byUid[item.importUid];
    const keyMatch = existingIndex.byKey[makeCentralLogicalKey_(item.date, item.type, item.title)];
    item.duplicateStatus = uidMatch ? 'มีอยู่แล้ว' : (keyMatch ? 'อาจซ้ำ' : 'ใหม่');
    item.selected = item.duplicateStatus === 'ใหม่';
    items.push(item);
  });

  if (!items.length) throw new Error('ไม่พบข้อมูลของปี พ.ศ. ' + buddhistYear + ' ในไฟล์นี้');
  const stats = items.reduce(function(acc, item) {
    acc.total++;
    if (item.duplicateStatus === 'ใหม่') acc.newItems++;
    else acc.duplicates++;
    return acc;
  }, { total: 0, newItems: 0, duplicates: 0 });

  return {
    meta: {
      calendarName: parsed.calendarName || sourceTypeLabel_(sourceType),
      calendarDescription: parsed.calendarDescription || '',
      sourceType: sourceType,
      sourceLabel: sourceTypeLabel_(sourceType),
      sourceUrl: sourceMeta.sourceUrl || '',
      sourceName: sourceMeta.sourceName || '',
      buddhistYear: buddhistYear,
      totalEventsInFile: parsed.events.length,
      matchedEvents: items.length
    },
    stats: stats,
    items: items
  };
}

function parseIcsDocument_(text) {
  const unfolded = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');
  const events = [];
  let current = null;
  let calendarName = '';
  let calendarDescription = '';
  lines.forEach(function(line) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      return;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      return;
    }
    const colon = line.indexOf(':');
    if (colon < 0) return;
    const left = line.slice(0, colon);
    const value = decodeIcsValue_(line.slice(colon + 1));
    const name = left.split(';')[0].toUpperCase();
    if (current) {
      if (current[name]) current[name] += '\n' + value;
      else current[name] = value;
    } else if (name === 'X-WR-CALNAME') {
      calendarName = value;
    } else if (name === 'X-WR-CALDESC') {
      calendarDescription = value;
    }
  });
  return { events: events, calendarName: calendarName, calendarDescription: calendarDescription };
}

function makeImportPreviewItem_(event, sourceType, context) {
  const summaryRaw = normalizeSpace_(event.SUMMARY || '');
  const descriptionRaw = normalizeSpace_(event.DESCRIPTION || '');
  let lunar = extractLunarText_(descriptionRaw || summaryRaw);
  if (context.convertDigits) lunar = thaiDigitsToArabic_(lunar);
  let title = cleanIcsSummary_(summaryRaw, lunar);
  let type = 'อื่นๆ';
  let isBuddhistDay = false;
  let isHoliday = false;
  let color = '#694497';
  let displayOrder = 30;

  if (sourceType === 'buddhist') {
    isBuddhistDay = isUposathaLunar_(lunar);
    const buddhistName = detectBuddhistImportantName_(title || summaryRaw);
    if (buddhistName) {
      title = buddhistName;
      type = 'วันสำคัญทางพระพุทธศาสนา';
      color = '#6B2C91';
      displayOrder = 10;
    } else {
      title = 'วันพระ';
      type = 'วันพระ';
      color = '#D5A62E';
      displayOrder = 20;
    }
    isHoliday = context.markHoliday && isOfficialBuddhistHoliday_(title);
  } else if (sourceType === 'holiday') {
    title = title || summaryRaw || 'วันหยุดราชการ';
    type = 'วันหยุดราชการ';
    isHoliday = context.markHoliday;
    color = '#B4233E';
    displayOrder = 5;
  } else if (sourceType === 'lunar') {
    title = '';
    type = 'ข้อมูลจันทรคติ';
    isHoliday = false;
    isBuddhistDay = false;
    color = '#746B75';
    displayOrder = 90;
  }

  const sourceLabel = 'MyHora • ' + sourceTypeLabel_(sourceType);
  const uid = 'MYHORA:' + cleanText_(event.UID || makeStableUid_(parseIcsDateKey_(event.DTSTART || '') + '|' + summaryRaw + '|' + sourceType));
  return {
    selected: true,
    date: parseIcsDateKey_(event.DTSTART || ''),
    lunar: lunar,
    isBuddhistDay: isBuddhistDay,
    type: type,
    title: title,
    isHoliday: isHoliday,
    source: sourceLabel,
    note: descriptionRaw,
    visibility: 'แสดง',
    color: color,
    displayOrder: displayOrder,
    importUid: uid,
    sourceUrl: context.sourceUrl || context.sourceName || '',
    duplicateStatus: 'ใหม่'
  };
}

function normalizeImportItem_(rawItem, batchId, now, meta) {
  if (!rawItem.date) throw new Error('พบรายการที่ไม่มีวันที่');
  const source = cleanText_(rawItem.source || ('MyHora • ' + sourceTypeLabel_(meta.sourceType || 'auto')));
  if (source.indexOf('MyHora') !== 0) throw new Error('รายการนำเข้าต้องมาจาก MyHora');
  return [
    parseClientDate_(rawItem.date),
    cleanText_(rawItem.lunar),
    toBoolean_(rawItem.isBuddhistDay),
    cleanText_(rawItem.type || 'อื่นๆ'),
    cleanText_(rawItem.title),
    toBoolean_(rawItem.isHoliday),
    source,
    cleanText_(rawItem.note),
    cleanText_(rawItem.visibility || 'แสดง'),
    cleanText_(rawItem.color || '#694497'),
    Number(rawItem.displayOrder || 30),
    cleanText_(rawItem.importUid || makeStableUid_(rawItem.date + '|' + rawItem.type + '|' + rawItem.title)),
    batchId,
    now,
    cleanText_(rawItem.sourceUrl || meta.sourceUrl || meta.sourceName || ''),
    cleanText_(rawItem.iconKey || '')
  ];
}

function readCentralRowsForImport_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < APP.CENTRAL_START_ROW) return [];
  return sheet.getRange(APP.CENTRAL_START_ROW, 1, lastRow - APP.CENTRAL_START_ROW + 1, APP.CENTRAL_COLUMNS).getValues()
    .map(function(values, index) { return { rowNumber: APP.CENTRAL_START_ROW + index, values: values }; })
    .filter(function(entry) { return entry.values[0]; });
}

function buildCentralIndexes_(rows) {
  const byUid = {};
  const byKey = {};
  (rows || []).forEach(function(entry) {
    const uid = String(entry.values[11] || '');
    const key = makeCentralLogicalKey_(entry.values[0], entry.values[3], entry.values[4]);
    if (uid) byUid[uid] = entry;
    if (key) byKey[key] = entry;
  });
  return { byUid: byUid, byKey: byKey };
}

function makeCentralLogicalKey_(dateValue, type, title) {
  const dateKey = formatDateForClient_(dateValue);
  return [dateKey, normalizeSpace_(type).toLowerCase(), normalizeSpace_(title).toLowerCase()].join('|');
}

function resolveIcsSourceType_(requested, calendarName, sourceName, events) {
  const allowed = ['buddhist', 'holiday', 'lunar'];
  if (allowed.indexOf(String(requested || '').toLowerCase()) >= 0) return String(requested).toLowerCase();
  const text = [calendarName, sourceName].concat((events || []).slice(0, 5).map(function(e) { return e.SUMMARY || ''; })).join(' ').toLowerCase();
  if (text.indexOf('จันทรคติ') >= 0 || text.indexOf('/thai.') >= 0) return 'lunar';
  if (text.indexOf('วันหยุด') >= 0 || text.indexOf('/holiday.') >= 0) return 'holiday';
  return 'buddhist';
}

function sourceTypeLabel_(type) {
  return ({ buddhist: 'ปฏิทินวันพระ', holiday: 'ปฏิทินวันหยุด', lunar: 'ปฏิทินจันทรคติไทย' })[type] || 'ปฏิทิน MyHora';
}

function validateMyHoraUrl_(url) {
  const text = String(url || '').trim();
  if (!text) throw new Error('กรุณาระบุ URL ไฟล์ ICS');
  const match = text.match(/^https:\/\/(?:www\.)?myhora\.com\/(.+)$/i);
  if (!match) {
    throw new Error('เพื่อความปลอดภัย ระบบอนุญาตเฉพาะ URL แบบ https:// จาก myhora.com');
  }
  return text;
}

function parseIcsDateKey_(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d{4})(\d{2})(\d{2})/);
  if (!match) return '';
  return match[1] + '-' + match[2] + '-' + match[3];
}

function decodeIcsValue_(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function normalizeSpace_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanIcsSummary_(summary, lunar) {
  let text = String(summary || '')
    .replace(/[🌓🌕🌗🌑🌖🌔🌘☸️☸]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (lunar) {
    const escaped = lunar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped + '$'), '').trim();
  }
  text = text.replace(/(ขึ้น|แรม)\s*[๐-๙0-9]+\s*ค่ำ\s*เดือน.+$/i, '').trim();
  return text;
}

function extractLunarText_(text) {
  let value = normalizeSpace_(text);
  value = value.replace(/^วัน(?:อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์|เสาร์)\s+/, '');
  value = value.replace(/\s+ปี(?:ชวด|ฉลู|ขาล|เถาะ|มะโรง|มะเส็ง|มะเมีย|มะแม|วอก|ระกา|จอ|กุน).*$/, '');
  const match = value.match(/(ขึ้น|แรม)\s*[๐-๙0-9]+\s*ค่ำ\s*เดือน[^\n,]+/);
  return match ? normalizeSpace_(match[0]) : '';
}

function thaiDigitsToArabic_(value) {
  const thai = '๐๑๒๓๔๕๖๗๘๙';
  return String(value || '').replace(/[๐-๙]/g, function(ch) { return String(thai.indexOf(ch)); });
}

function isUposathaLunar_(lunar) {
  const text = thaiDigitsToArabic_(lunar);
  return /(ขึ้น|แรม)\s*(8|14|15)\s*ค่ำ/.test(text);
}

function detectBuddhistImportantName_(text) {
  const names = ['วันมาฆบูชา', 'วันวิสาขบูชา', 'วันอัฏฐมีบูชา', 'วันอาสาฬหบูชา', 'วันอาสฬหบูชา', 'วันเข้าพรรษา', 'วันออกพรรษา'];
  const source = String(text || '');
  for (let i = 0; i < names.length; i++) {
    if (source.indexOf(names[i]) >= 0) return names[i] === 'วันอาสฬหบูชา' ? 'วันอาสาฬหบูชา' : names[i];
  }
  return '';
}

function isOfficialBuddhistHoliday_(title) {
  return ['วันมาฆบูชา', 'วันวิสาขบูชา', 'วันอาสาฬหบูชา', 'วันเข้าพรรษา'].indexOf(String(title || '')) >= 0;
}

function makeStableUid_(text) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text || ''), Utilities.Charset.UTF_8);
  return digest.map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 32);
}

function createImportBatchId_() {
  return 'IMP-' + Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
}

function saveImportBackup_(backup) {
  const folder = DriveApp.getFolderById(APP.FOLDER_ID);
  const name = 'calendar-import-backup-' + backup.batchId + '.json';
  const blob = Utilities.newBlob(JSON.stringify(backup), 'application/json', name);
  const file = folder.createFile(blob);
  file.setDescription('ไฟล์สำรองสำหรับย้อนกลับการนำเข้าปฏิทิน ' + backup.batchId);
  return file;
}

function writeImportHistory_(record) {
  const sheet = getSheet_(APP.SHEETS.IMPORTS);
  const row = Math.max(sheet.getLastRow() + 1, APP.IMPORTS_START_ROW);
  sheet.getRange(row, 1, 1, APP.IMPORT_HISTORY_COLUMNS).setValues([[
    record.batchId,
    record.date,
    record.sourceType,
    record.buddhistYear,
    record.sourceLabel,
    record.sourceLocation,
    record.selected,
    record.added,
    record.updated,
    record.skipped,
    record.errors,
    record.strategy,
    record.status,
    record.backupFileId,
    record.user
  ]]);
  sheet.getRange(row, 2).setNumberFormat('dd/MM/yyyy HH:mm');
}

function findImportHistoryRow_(sheet, batchId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < APP.IMPORTS_START_ROW) return 0;
  const finder = sheet.getRange(APP.IMPORTS_START_ROW, 1, lastRow - APP.IMPORTS_START_ROW + 1, 1)
    .createTextFinder(String(batchId || ''))
    .matchEntireCell(true)
    .findNext();
  return finder ? finder.getRow() : 0;
}

function padSheetRow_(row, length) {
  const output = Array.isArray(row) ? row.slice(0, length) : [];
  while (output.length < length) output.push('');
  return output;
}

function serializeSheetRow_(row) {
  return row.map(function(value) {
    if (value instanceof Date) return { __type: 'date', value: value.toISOString() };
    return value;
  });
}

function deserializeSheetRow_(row) {
  return (row || []).map(function(value) {
    if (value && typeof value === 'object' && value.__type === 'date') return new Date(value.value);
    return value;
  });
}

function ensureCentralImportColumns_(sheet) {
  if (sheet.getMaxColumns() < APP.CENTRAL_COLUMNS) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), APP.CENTRAL_COLUMNS - sheet.getMaxColumns());
  }
  const headers = ['รหัสนำเข้า', 'ชุดนำเข้า', 'นำเข้าเมื่อ', 'URL/ไฟล์ต้นทาง', 'รหัสไอคอน'];
  sheet.getRange(2, 12, 1, 5).setValues([headers]);
  sheet.getRange(2, 12, 1, 5)
    .setBackground('#6B2C91')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(2);
  sheet.getRange(3, 14, Math.max(sheet.getMaxRows() - 2, 1), 1).setNumberFormat('dd/MM/yyyy HH:mm');
  const iconSheet = getSpreadsheet_().getSheetByName(APP.SHEETS.ICONS);
  if (iconSheet) {
    const validation = SpreadsheetApp.newDataValidation()
      .requireValueInRange(iconSheet.getRange('A3:A120'), true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(3, 16, Math.max(sheet.getMaxRows() - 2, 1), 1).setDataValidation(validation);
  }
  sheet.setColumnWidth(16, 180);
}

function ensureIconSettingsSheet_(ss) {
  let sheet = ss.getSheetByName(APP.SHEETS.ICONS);
  if (!sheet) sheet = ss.insertSheet(APP.SHEETS.ICONS);
  if (sheet.getMaxColumns() < 12) sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
  if (sheet.getMaxRows() < 120) sheet.insertRowsAfter(sheet.getMaxRows(), 120 - sheet.getMaxRows());

  const headers = ['รหัสไอคอน', 'ชื่อไอคอน', 'รูปแบบไอคอน', 'ค่าไอคอน', 'URL รูปภาพ', 'สีพื้นหลัง', 'สีไอคอน/ขอบ', 'ขนาด (px)', 'แสดงผล', 'ลำดับ', 'ประเภทเริ่มต้น', 'หมายเหตุ'];
  sheet.getRange(1, 1, 1, 12).breakApart();
  sheet.getRange(1, 1, 1, 12).merge();
  sheet.getRange(1, 1).setValue('ตั้งค่าไอคอนระบบปฏิทินกิจกรรม — แก้ไขได้จากหลังบ้าน');
  sheet.getRange(2, 1, 1, 12).setValues([headers]);
  sheet.getRange(1, 1, 1, 12).setBackground('#8F1D54').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(16).setHorizontalAlignment('center');
  sheet.getRange(2, 1, 1, 12).setBackground('#6B2C91').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setFrozenRows(2);

  const defaults = [
    ['MCU_LOGO', 'โลโก้มหาวิทยาลัย', 'โลโก้ระบบ', '@logo', '', '#FFFDF8', '#D5A62E', 22, true, 10, 'กิจกรรมส่วนกลาง มจร.', 'ใช้ LOGO_URL จากชีตตั้งค่าระบบ'],
    ['MCU_IMPORTANT', 'วันสำคัญของมหาวิทยาลัย', 'โลโก้ระบบ', '@logo', '', '#FFF7FB', '#8F1D54', 22, true, 11, 'วันสำคัญของมหาวิทยาลัย', 'แสดงตรามหาวิทยาลัย'],
    ['MOON_AUTO', 'วันพระตามข้างขึ้นข้างแรม', 'พระจันทร์อัตโนมัติ', 'moon-auto', '', '#FFF8E8', '#D5A62E', 22, true, 5, 'วันพระ', 'เลือกครึ่งดวงหรือเต็มดวงอัตโนมัติ'],
    ['BUDDHIST_IMPORTANT', 'วันสำคัญทางพระพุทธศาสนา', 'Emoji', '☸', '', '#F8F0FF', '#6B2C91', 20, true, 12, 'วันสำคัญทางพระพุทธศาสนา', 'สามารถเปลี่ยนเป็น Emoji หรือรูปภาพ URL ได้'],
    ['HOLIDAY_FLAG', 'วันหยุดราชการ', 'Lucide', 'flag', '', '#FFF1F5', '#B4233E', 20, true, 20, 'วันหยุดราชการ', 'ใช้ชื่อไอคอนจาก Lucide Icons'],
    ['UNIVERSITY_HOLIDAY', 'วันหยุดมหาวิทยาลัย', 'โลโก้ระบบ', '@logo', '', '#F6ECFF', '#6B2C91', 20, true, 21, 'วันหยุดมหาวิทยาลัย', 'แสดงตรามหาวิทยาลัย'],
    ['EDUCATION', 'วันสำคัญทางการศึกษา', 'Lucide', 'graduation-cap', '', '#EEF5FF', '#245A9C', 20, true, 30, 'วันสำคัญทางการศึกษา', 'เช่น เปิดภาคเรียน สอบ ลงทะเบียน'],
    ['CENTRAL_SPARKLE', 'กิจกรรมส่วนกลางทั่วไป', 'Lucide', 'sparkles', '', '#F8F0FF', '#6B2C91', 20, true, 40, 'อื่นๆ', 'ใช้เมื่อไม่ต้องการใช้โลโก้'],
    ['CUSTOM_IMAGE', 'รูปภาพกำหนดเอง', 'รูปภาพ URL', '@url', 'https://img2.pic.in.th/-a47d4369f36e7693.png', '#FFFDF8', '#D5A62E', 22, true, 50, '', 'เปลี่ยน URL รูปภาพในคอลัมน์ E'],
    ['NO_ICON', 'ไม่แสดงไอคอน', 'ไม่แสดง', '', '', '#FFFFFF', '#746B75', 20, true, 99, 'ข้อมูลจันทรคติ', 'ซ่อนไอคอน']
  ];

  const lastRow = Math.max(sheet.getLastRow(), 2);
  const existingKeys = lastRow >= 3 ? sheet.getRange(3, 1, lastRow - 2, 1).getDisplayValues().map(function(r) { return r[0]; }) : [];
  defaults.forEach(function(row) {
    if (existingKeys.indexOf(row[0]) === -1) sheet.appendRow(row);
  });

  const typeValidation = SpreadsheetApp.newDataValidation()
    .requireValueInList(['โลโก้ระบบ', 'รูปภาพ URL', 'Lucide', 'Emoji', 'พระจันทร์อัตโนมัติ', 'ไม่แสดง'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(3, 3, Math.max(sheet.getMaxRows() - 2, 1), 1).setDataValidation(typeValidation);
  const checkboxValidation = SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(false).build();
  sheet.getRange(3, 9, Math.max(sheet.getMaxRows() - 2, 1), 1).setDataValidation(checkboxValidation);
  const optionsSheet = ss.getSheetByName(APP.SHEETS.OPTIONS);
  if (optionsSheet) {
    const centralTypeValidation = SpreadsheetApp.newDataValidation()
      .requireValueInRange(optionsSheet.getRange('C3:C120'), true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(3, 11, Math.max(sheet.getMaxRows() - 2, 1), 1).setDataValidation(centralTypeValidation);
  }
  sheet.setColumnWidths(1, 1, 150);
  sheet.setColumnWidths(2, 2, 190);
  sheet.setColumnWidths(4, 2, 230);
  sheet.setColumnWidths(6, 3, 130);
  sheet.setColumnWidths(9, 2, 90);
  sheet.setColumnWidth(11, 240);
  sheet.setColumnWidth(12, 360);
}

function ensureImportHistorySheet_(ss) {
  let sheet = ss.getSheetByName(APP.SHEETS.IMPORTS);
  if (!sheet) sheet = ss.insertSheet(APP.SHEETS.IMPORTS);
  if (sheet.getMaxColumns() < APP.IMPORT_HISTORY_COLUMNS) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), APP.IMPORT_HISTORY_COLUMNS - sheet.getMaxColumns());
  }
  const title = 'ประวัติการนำเข้าปฏิทิน ICS / MyHora';
  const headers = ['รหัสนำเข้า', 'วันที่เวลา', 'ประเภทแหล่งข้อมูล', 'ปี พ.ศ.', 'ชื่อปฏิทิน', 'URL/ไฟล์', 'เลือกนำเข้า', 'เพิ่มใหม่', 'อัปเดต', 'ข้าม', 'ข้อขัดแย้ง', 'วิธีจัดการข้อมูลซ้ำ', 'สถานะ', 'รหัสไฟล์สำรอง', 'ผู้ดำเนินการ'];
  sheet.getRange(1, 1, 1, APP.IMPORT_HISTORY_COLUMNS).breakApart();
  sheet.getRange(1, 1, 1, APP.IMPORT_HISTORY_COLUMNS).merge();
  sheet.getRange(1, 1).setValue(title);
  sheet.getRange(2, 1, 1, APP.IMPORT_HISTORY_COLUMNS).setValues([headers]);
  sheet.getRange(1, 1, 1, APP.IMPORT_HISTORY_COLUMNS).setBackground('#8F1D54').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(16).setHorizontalAlignment('center');
  sheet.getRange(2, 1, 1, APP.IMPORT_HISTORY_COLUMNS).setBackground('#6B2C91').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setFrozenRows(2);
  sheet.getRange(3, 2, Math.max(sheet.getMaxRows() - 2, 1), 1).setNumberFormat('dd/MM/yyyy HH:mm');
}

function ensureImportOptions_(sheet) {
  const lastRow = Math.max(sheet.getLastRow(), 3);
  const values = sheet.getRange(3, 3, lastRow - 2, 1).getDisplayValues().map(function(row) { return row[0]; });
  if (values.indexOf('ข้อมูลจันทรคติ') === -1) {
    const row = Math.max(sheet.getLastRow() + 1, 3);
    sheet.getRange(row, 3).setValue('ข้อมูลจันทรคติ');
  }
}

function ensureImportSettings_(sheet) {
  const defaults = {
    MYHORA_BUDDHIST_URL: APP.MYHORA_URLS.buddhist,
    MYHORA_HOLIDAY_URL: APP.MYHORA_URLS.holiday,
    MYHORA_LUNAR_URL: APP.MYHORA_URLS.lunar
  };
  const descriptions = {
    MYHORA_BUDDHIST_URL: 'URL ปฏิทินวันพระจาก MyHora',
    MYHORA_HOLIDAY_URL: 'URL ปฏิทินวันหยุดจาก MyHora',
    MYHORA_LUNAR_URL: 'URL ปฏิทินจันทรคติไทยจาก MyHora'
  };
  const lastRow = Math.max(sheet.getLastRow(), APP.SETTINGS_START_ROW);
  const data = sheet.getRange(APP.SETTINGS_START_ROW, 1, lastRow - APP.SETTINGS_START_ROW + 1, 1).getDisplayValues();
  const existing = data.map(function(row) { return row[0]; });
  Object.keys(defaults).forEach(function(key) {
    if (existing.indexOf(key) === -1) {
      const row = Math.max(sheet.getLastRow() + 1, APP.SETTINGS_START_ROW);
      sheet.getRange(row, 1, 1, 3).setValues([[key, defaults[key], descriptions[key]]]);
    }
  });
}

/* =========================
   DATA READERS
========================= */

function getActivities_(ss) {
  const sheet = ss ? ss.getSheetByName(APP.SHEETS.ACTIVITIES) : getSheet_(APP.SHEETS.ACTIVITIES);
  if (!sheet) throw new Error('ไม่พบชีต: ' + APP.SHEETS.ACTIVITIES);

  const bounds = getUsedRowBounds_(sheet, APP.ACTIVITY_START_ROW, 1);
  if (!bounds) return [];

  const values = sheet.getRange(bounds.firstRow, 1, bounds.lastRow - bounds.firstRow + 1, 14).getValues();
  const output = [];
  values.forEach(function(row, index) {
    if (!hasCellValue_(row[0]) || !hasCellValue_(row[1]) || !hasCellValue_(row[3])) return;
    output.push(mapActivityRow_(row, bounds.firstRow + index));
  });
  return output;
}

function getCentralCalendar_(ss) {
  const sheet = ss ? ss.getSheetByName(APP.SHEETS.CENTRAL) : getSheet_(APP.SHEETS.CENTRAL);
  if (!sheet) throw new Error('ไม่พบชีต: ' + APP.SHEETS.CENTRAL);

  // ตรวจเฉพาะคอลัมน์วันที่ก่อน แล้วอ่านเฉพาะช่วงที่มีข้อมูลจริง
  // ช่วยหลีกเลี่ยงการอ่านแถว Checkbox ว่างจำนวนมากในชีต
  const bounds = getUsedRowBounds_(sheet, APP.CENTRAL_START_ROW, 1);
  if (!bounds) return [];

  const values = sheet.getRange(bounds.firstRow, 1, bounds.lastRow - bounds.firstRow + 1, APP.CENTRAL_COLUMNS).getValues();
  const output = [];
  values.forEach(function(row, index) {
    if (!hasCellValue_(row[0])) return;
    output.push(mapCentralRow_(row, bounds.firstRow + index));
  });
  return output;
}

function getSettings_(ss) {
  const sheet = ss ? ss.getSheetByName(APP.SHEETS.SETTINGS) : getSheet_(APP.SHEETS.SETTINGS);
  if (!sheet) throw new Error('ไม่พบชีต: ' + APP.SHEETS.SETTINGS);
  const lastRow = sheet.getLastRow();
  const output = {};
  if (lastRow >= APP.SETTINGS_START_ROW) {
    const values = sheet.getRange(APP.SETTINGS_START_ROW, 1, lastRow - APP.SETTINGS_START_ROW + 1, 2).getValues();
    values.forEach(row => {
      const key = String(row[0] || '').trim();
      if (key) output[key] = row[1];
    });
  }
  output.SPREADSHEET_ID = APP.SPREADSHEET_ID;
  output.FOLDER_ID = APP.FOLDER_ID;
  output.TIMEZONE = APP.TIMEZONE;
  return output;
}

function getOptions_(ss) {
  const sheet = ss ? ss.getSheetByName(APP.SHEETS.OPTIONS) : getSheet_(APP.SHEETS.OPTIONS);
  if (!sheet) throw new Error('ไม่พบชีต: ' + APP.SHEETS.OPTIONS);
  const lastRow = sheet.getLastRow();
  const result = {
    activityTypes: [],
    activityStatuses: [],
    centralTypes: [],
    visibilityStatuses: [],
    themeColors: [],
    userGroups: []
  };
  if (lastRow < 3) return result;
  const values = sheet.getRange(3, 1, lastRow - 2, 6).getDisplayValues();
  values.forEach(row => {
    pushUnique_(result.activityTypes, row[0]);
    pushUnique_(result.activityStatuses, row[1]);
    pushUnique_(result.centralTypes, row[2]);
    pushUnique_(result.visibilityStatuses, row[3]);
    pushUnique_(result.themeColors, row[4]);
    pushUnique_(result.userGroups, row[5]);
  });
  return result;
}

function getIconSettings_(ss) {
  const sheet = (ss || getSpreadsheet_()).getSheetByName(APP.SHEETS.ICONS);
  if (!sheet || sheet.getLastRow() < 3) return [];
  const values = sheet.getRange(3, 1, sheet.getLastRow() - 2, 12).getValues();
  return values.map(function(row) {
    return {
      key: String(row[0] || '').trim(),
      name: String(row[1] || ''),
      iconType: String(row[2] || ''),
      iconValue: String(row[3] || ''),
      imageUrl: String(row[4] || ''),
      backgroundColor: String(row[5] || '#FFFFFF'),
      iconColor: String(row[6] || '#6B2C91'),
      size: Math.min(Math.max(Number(row[7] || 20), 14), 32),
      enabled: toBoolean_(row[8]),
      order: Number(row[9] || 50),
      defaultType: String(row[10] || ''),
      note: String(row[11] || '')
    };
  }).filter(function(item) { return item.key; }).sort(function(a, b) { return a.order - b.order; });
}


function getSystemLogs(token, limit) {
  try {
    requireAdmin_(token);
    const sheet = getSheet_(APP.SHEETS.LOGS);
    const lastRow = sheet.getLastRow();
    if (lastRow < 3) return success_({ logs: [] });
    const n = Math.min(Math.max(Number(limit || 100), 1), 500);
    const start = Math.max(3, lastRow - n + 1);
    const values = sheet.getRange(start, 1, lastRow - start + 1, 6).getDisplayValues().reverse();
    return success_({ logs: values });
  } catch (err) {
    return failure_(err);
  }
}

/* =========================
   MAPPERS / VALIDATORS
========================= */

function mapActivityRow_(row, rowNumber) {
  return {
    rowNumber: rowNumber,
    id: String(row[0] || ''),
    startDate: formatDateForClient_(row[1]),
    endDate: formatDateForClient_(row[2] || row[1]),
    title: String(row[3] || ''),
    type: String(row[4] || ''),
    owner: String(row[5] || ''),
    related: String(row[6] || ''),
    location: String(row[7] || ''),
    description: String(row[8] || ''),
    status: String(row[9] || ''),
    color: String(row[10] || '#8F1D54'),
    attachmentUrl: String(row[11] || ''),
    createdAt: formatDateTimeForClient_(row[12]),
    updatedAt: formatDateTimeForClient_(row[13])
  };
}

function mapCentralRow_(row, rowNumber) {
  return {
    rowNumber: rowNumber,
    date: formatDateForClient_(row[0]),
    lunar: String(row[1] || ''),
    isBuddhistDay: toBoolean_(row[2]),
    type: String(row[3] || ''),
    title: String(row[4] || ''),
    isHoliday: toBoolean_(row[5]),
    source: String(row[6] || ''),
    note: String(row[7] || ''),
    visibility: String(row[8] || 'แสดง'),
    color: String(row[9] || '#D5A62E'),
    displayOrder: Number(row[10] || 10),
    importUid: String(row[11] || ''),
    importBatchId: String(row[12] || ''),
    importedAt: formatDateTimeForClient_(row[13]),
    sourceUrl: String(row[14] || ''),
    iconKey: String(row[15] || '')
  };
}

function validateActivityPayload_(payload) {
  if (!payload.startDate) throw new Error('กรุณาระบุวันที่เริ่ม');
  if (!String(payload.title || '').trim()) throw new Error('กรุณาระบุชื่อกิจกรรม');
  if (String(payload.title).length > 300) throw new Error('ชื่อกิจกรรมยาวเกินไป');
}

function findActivityRow_(sheet, id, preferredRow) {
  if (preferredRow >= APP.ACTIVITY_START_ROW && preferredRow <= sheet.getLastRow()) {
    if (String(sheet.getRange(preferredRow, 1).getValue()) === String(id)) return preferredRow;
  }
  if (!id || sheet.getLastRow() < APP.ACTIVITY_START_ROW) return 0;
  const finder = sheet.getRange(APP.ACTIVITY_START_ROW, 1, sheet.getLastRow() - APP.ACTIVITY_START_ROW + 1, 1)
    .createTextFinder(String(id))
    .matchEntireCell(true)
    .findNext();
  return finder ? finder.getRow() : 0;
}

/* =========================
   HELPERS
========================= */

function hasCellValue_(value) {
  if (value instanceof Date) return !isNaN(value.getTime());
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function getUsedRowBounds_(sheet, startRow, keyColumn) {
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) return null;

  const keyValues = sheet.getRange(startRow, keyColumn, lastRow - startRow + 1, 1).getValues();
  let firstOffset = -1;
  let lastOffset = -1;

  for (let i = 0; i < keyValues.length; i++) {
    if (!hasCellValue_(keyValues[i][0])) continue;
    if (firstOffset === -1) firstOffset = i;
    lastOffset = i;
  }

  if (firstOffset === -1) return null;
  return {
    firstRow: startRow + firstOffset,
    lastRow: startRow + lastOffset
  };
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(APP.SPREADSHEET_ID);
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('ไม่พบชีต: ' + name);
  return sheet;
}

function requireAdmin_(token) {
  if (!isValidToken_(token)) throw new Error('เซสชันผู้ดูแลหมดอายุ กรุณาเข้าสู่ระบบใหม่');
}

function isValidToken_(token) {
  if (!token) return false;
  const cache = CacheService.getScriptCache();
  const key = 'ADMIN_TOKEN_' + token;
  const found = cache.get(key);
  if (found) cache.put(key, '1', APP.TOKEN_TTL_SECONDS);
  return !!found;
}

function hashPassword_(password) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password), Utilities.Charset.UTF_8);
  return digest.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function createActivityId_() {
  return 'ACT-' + Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
}

function parseClientDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const str = String(value || '').trim();
  let match = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year > 2400) year -= 543;
    else if (year < 100) year += 2000;
    return new Date(year, Number(match[2]) - 1, Number(match[1]));
  }
  const date = new Date(str);
  if (isNaN(date.getTime())) throw new Error('รูปแบบวันที่ไม่ถูกต้อง: ' + str);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateForClient_(value) {
  if (!value) return '';
  let date = value;
  if (!(date instanceof Date)) {
    try { date = parseClientDate_(value); } catch (e) { return ''; }
  }
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, APP.TIMEZONE, 'yyyy-MM-dd');
}

function formatDateTimeForClient_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, APP.TIMEZONE, 'dd/MM/yyyy HH:mm');
}

function toBoolean_(value) {
  if (value === true || value === 1) return true;
  const str = String(value || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'ใช่'].includes(str);
}

function cleanText_(value) {
  return String(value == null ? '' : value).trim();
}

function sanitizeFilename_(name) {
  const cleaned = String(name || 'attachment')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd_HHmmss') + '_' + cleaned;
}

function pushUnique_(array, value) {
  const text = String(value || '').trim();
  if (text && !array.includes(text)) array.push(text);
}

function logAction_(user, action, detail, refId) {
  try {
    const sheet = getSheet_(APP.SHEETS.LOGS);
    const row = Math.max(sheet.getLastRow() + 1, 3);
    sheet.getRange(row, 1, 1, 6).setValues([[
      new Date(),
      cleanText_(user),
      cleanText_(action),
      cleanText_(detail),
      cleanText_(refId),
      'Web App'
    ]]);
    sheet.getRange(row, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  } catch (err) {
    console.error('Log error:', err);
  }
}

function success_(data) {
  return Object.assign({ status: 'success' }, data || {});
}

function failure_(err) {
  console.error(err && err.stack ? err.stack : err);
  return { status: 'error', message: err && err.message ? err.message : String(err || 'เกิดข้อผิดพลาด') };
}
