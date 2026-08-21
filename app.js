(() => {
  'use strict';

  const STORAGE_KEY = 'forklift_log_data';
  const PLAN_NOTICE_KEY = 'buildnote_free_plan_notice_v1';
  const FONT_SIZE_KEY = 'jangbion_font_size_v1';
  const FONT_SIZE_OPTIONS = ['small', 'normal', 'large', 'xlarge', 'xxlarge'];
  const APP_VERSION = '3.6.14';
  const SUBMISSION_ROOM_KEY = 'jangbion_submission_room_url_v1';
  const SW_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
  const DB_VERSION = 8;
  const MAX_WORK_PHOTOS = 4;
  const APPROX_STORAGE_LIMIT = 50 * 1024 * 1024;
  const IDB_NAME = 'jangbion_db';
  const IDB_VERSION = 1;
  const PHOTO_RETENTION_KEY = 'jangbion_photo_retention_days';
  const BACKUP_REMINDER_KEY = 'jangbion_last_backup_at';
  const WORK_FIELD_LAYOUT_KEY = 'jangbion_work_field_layout_v1';
  const SECRET_MODE_KEY = 'jangbion_secret_mode_v1';
  const DEFAULT_PHOTO_RETENTION_DAYS = 90;
  const DAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const numberOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const isDateString = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

  let idb = null;
  let persistQueue = Promise.resolve();
  let lastPersistError = null;
  const objectUrlByPhotoId = new Map();

  function openIdb() {
    if (idb) return Promise.resolve(idb);
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB를 지원하지 않습니다.'));
        return;
      }
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onerror = () => reject(request.error || new Error('IndexedDB 열기 실패'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections');
        if (!db.objectStoreNames.contains('photos')) {
          const photos = db.createObjectStore('photos', { keyPath: 'id' });
          photos.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      request.onsuccess = () => {
        idb = request.result;
        resolve(idb);
      };
    });
  }

  function idbReq(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dataUrlToBlob(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    if (dataUrl.startsWith('blob:')) return null;
    if (!dataUrl.startsWith('data:')) return null;
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    const header = parts[0];
    const data = parts.slice(1).join(',');
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    try {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  async function blobFromDisplayValue(value) {
    if (!value) return null;
    if (typeof value !== 'string') return null;
    if (value.startsWith('data:')) return dataUrlToBlob(value);
    if (value.startsWith('blob:')) {
      try {
        const response = await fetch(value);
        return await response.blob();
      } catch (error) {
        console.warn(error);
        return null;
      }
    }
    return null;
  }

  function revokePhotoUrls() {
    objectUrlByPhotoId.forEach(url => {
      try { URL.revokeObjectURL(url); } catch (error) { /* ignore */ }
    });
    objectUrlByPhotoId.clear();
  }

  async function materializePhotoRef(photoId, blob) {
    if (!photoId || !blob) return '';
    if (objectUrlByPhotoId.has(photoId)) return objectUrlByPhotoId.get(photoId);
    const url = URL.createObjectURL(blob);
    objectUrlByPhotoId.set(photoId, url);
    return url;
  }

  function collectionKeys() {
    return ['equipments', 'dailyLogs', 'workLogs', 'fuelLogs', 'maintLogs', 'dayStatuses', 'submissions', 'operationSessions', 'inspections', 'faultReports', 'equipmentDocs', 'aiImageAnalyses', 'aiCorrections'];
  }

  function walkPhotoFields(db, visitor, options = {}) {
    (db.dailyLogs || []).forEach(item => visitor(item, 'photo', item.photo, (next) => { item.photo = next; }));
    (db.workLogs || []).forEach(item => {
      const list = Array.isArray(item.photos) ? item.photos : (item.photo ? [item.photo] : []);
      const nextList = list.map((photo, index) => {
        let replaced = photo;
        visitor(item, `photos.${index}`, photo, (next) => { replaced = next; });
        return replaced;
      });
      item.photos = nextList;
      if ('photo' in item) item.photo = nextList[0] || '';
    });
    (db.fuelLogs || []).forEach(item => visitor(item, 'receipt', item.receipt, (next) => { item.receipt = next; }));
    (db.maintLogs || []).forEach(item => visitor(item, 'photo', item.photo, (next) => { item.photo = next; }));
    (db.inspections || []).forEach(item => visitor(item, 'photo', item.photo, (next) => { item.photo = next; }));
    (db.faultReports || []).forEach(item => visitor(item, 'photo', item.photo, (next) => { item.photo = next; }));
    (db.equipmentDocs || []).forEach(item => visitor(item, 'photo', item.photo, (next) => { item.photo = next; }));
    if (options.includeAnalysisRefs !== false) {
      (db.aiImageAnalyses || []).forEach(item => visitor(item, 'photoRef', item.photoRef, (next) => { item.photoRef = next; }));
    }
  }

  function isPhotoRef(value) {
    return typeof value === 'string' && value.startsWith('photo:');
  }

  function photoIdFromRef(value) {
    return isPhotoRef(value) ? value.slice(6) : '';
  }

  async function extractPhotosForPersist(db) {
    const photoPuts = [];
    const usedIds = new Set();
    const groups = new Map();
    walkPhotoFields(db, (owner, field, value, setValue) => {
      if (!value) return;
      if (isPhotoRef(value)) {
        usedIds.add(photoIdFromRef(value));
        return;
      }
      if (!groups.has(value)) groups.set(value, { owner, field, setters: [] });
      groups.get(value).setters.push(setValue);
    });
    await Promise.all([...groups.entries()].map(async ([value, group]) => {
      const blob = await blobFromDisplayValue(value);
      if (!blob) return;
      const id = uid('photo');
      usedIds.add(id);
      photoPuts.push({
        id,
        blob,
        mime: blob.type || 'image/jpeg',
        createdAt: group.owner.createdAt || group.owner.updatedAt || group.owner.completedAt || group.owner.occurredAt || new Date().toISOString(),
        ownerType: group.field,
        ownerId: group.owner.id || ''
      });
      group.setters.forEach(setValue => setValue(`photo:${id}`));
    }));
    return { photoPuts, usedIds };
  }

  async function hydratePhotosInDb(db) {
    const database = await openIdb();
    const refs = [];
    walkPhotoFields(db, (owner, field, value) => {
      if (isPhotoRef(value)) refs.push(photoIdFromRef(value));
    }, { includeAnalysisRefs: false });
    const unique = [...new Set(refs.filter(Boolean))];
    const blobs = new Map();
    await Promise.all(unique.map(async id => {
      const row = await idbReq(database.transaction('photos', 'readonly').objectStore('photos').get(id));
      if (row?.blob) blobs.set(id, row.blob);
    }));
    const hydrateTasks = [];
    walkPhotoFields(db, (owner, field, value, setValue) => {
      if (!isPhotoRef(value)) return;
      const id = photoIdFromRef(value);
      const blob = blobs.get(id);
      if (!blob) {
        setValue('');
        return;
      }
      hydrateTasks.push(materializePhotoRef(id, blob).then(url => setValue(url)));
    }, { includeAnalysisRefs: false });
    await Promise.all(hydrateTasks);
    return db;
  }

  async function persistDatabase(db, options = {}) {
    const database = await openIdb();
    const working = clone(db);
    const { photoPuts, usedIds } = await extractPhotosForPersist(working);
    const tx = database.transaction(['meta', 'collections', 'photos'], 'readwrite');
    const metaStore = tx.objectStore('meta');
    const colStore = tx.objectStore('collections');
    const photoStore = tx.objectStore('photos');
    metaStore.put({
      version: working.version || DB_VERSION,
      currentEquipmentId: working.currentEquipmentId,
      updatedAt: new Date().toISOString()
    }, 'app');
    collectionKeys().forEach(key => {
      colStore.put(working[key] || [], key);
    });
    for (const row of photoPuts) {
      photoStore.put(row);
    }
    if (options.pruneOrphans) {
      const allKeys = await idbReq(photoStore.getAllKeys());
      for (const key of allKeys) {
        if (!usedIds.has(key)) photoStore.delete(key);
      }
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('persist aborted'));
    });
    try { localStorage.removeItem(STORAGE_KEY); } catch (error) { /* ignore */ }
    lastPersistError = null;
  }

  function queuePersist(db, options) {
    persistQueue = persistQueue.then(() => persistDatabase(db, options)).catch(error => {
      console.error(error);
      lastPersistError = error;
      const quota = error && (error.name === 'QuotaExceededError' || /quota/i.test(String(error.message || '')));
      showToast(quota
        ? '저장 공간이 부족합니다. 오래된 사진을 정리하거나 백업 후 용량을 확보해주세요.'
        : '저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
    });
    return persistQueue;
  }

  async function loadFromIdb() {
    const database = await openIdb();
    const meta = await idbReq(database.transaction('meta', 'readonly').objectStore('meta').get('app'));
    if (!meta) return null;
    const raw = { version: meta.version, currentEquipmentId: meta.currentEquipmentId };
    for (const key of collectionKeys()) {
      raw[key] = await idbReq(database.transaction('collections', 'readonly').objectStore('collections').get(key)) || [];
    }
    const migrated = migrateDatabase(raw);
    await hydratePhotosInDb(migrated);
    return migrated;
  }

  async function migrateLocalStorageToIdb() {
    let stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      stored = null;
    }
    if (!stored) return null;
    let parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      return null;
    }
    const migrated = migrateDatabase(parsed);
    await persistDatabase(migrated, { pruneOrphans: true });
    await hydratePhotosInDb(migrated);
    return migrated;
  }

  async function loadDatabaseAsync() {
    try {
      const fromIdb = await loadFromIdb();
      if (fromIdb) return fromIdb;
    } catch (error) {
      console.warn('IndexedDB 로드 실패', error);
    }
    try {
      const migrated = await migrateLocalStorageToIdb();
      if (migrated) {
        showToast('저장 방식을 업그레이드했습니다. 기존 기록을 옮겼습니다.');
        return migrated;
      }
    } catch (error) {
      console.warn('localStorage 이관 실패', error);
      showToast('데이터 이동 중 문제가 있었습니다. 백업 후 다시 시도해주세요.');
    }
    return migrateDatabase({});
  }

  function getPhotoRetentionDays() {
    const raw = Number(localStorage.getItem(PHOTO_RETENTION_KEY));
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return DEFAULT_PHOTO_RETENTION_DAYS;
  }

  function setPhotoRetentionDays(days) {
    const value = Math.max(0, Math.floor(Number(days) || DEFAULT_PHOTO_RETENTION_DAYS));
    try { localStorage.setItem(PHOTO_RETENTION_KEY, String(value)); } catch (error) { console.warn(error); }
    return value;
  }

  function daysAgoIso(days) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return date.toISOString();
  }

  function stripPhotoRefsFromDb(db, removeIds) {
    const remove = new Set(removeIds);
    walkPhotoFields(db, (owner, field, value, setValue) => {
      if (isPhotoRef(value) && remove.has(photoIdFromRef(value))) setValue('');
      if (typeof value === 'string' && (value.startsWith('data:') || value.startsWith('blob:')) && remove.size) {
        // display values cleared only when matching refs already handled
      }
    });
  }

  async function purgePhotosOlderThan(days) {
    const database = await openIdb();
    const cutoff = daysAgoIso(days);
    const rows = await idbReq(database.transaction('photos', 'readonly').objectStore('photos').getAll());
    const stale = (rows || []).filter(row => String(row.createdAt || '') < cutoff);
    if (!stale.length) {
      showToast(`${days}일 이전 사진이 없습니다.`);
      return 0;
    }
    if (!confirm(`${days}일 이전 사진 ${stale.length}장을 삭제합니다. 텍스트 기록은 유지됩니다. 계속할까요?`)) return 0;
    const ids = stale.map(row => row.id);
    const next = clone(DB);
    stripPhotoRefsFromDb(next, ids);
    // also clear in-memory display strings that came from those photos by re-hydrate empty refs
    walkPhotoFields(next, (owner, field, value, setValue) => {
      if (typeof value === 'string' && value.startsWith('blob:')) {
        // leave; persist will not re-extract without data url — force empty if object url mapped
        for (const [id, url] of objectUrlByPhotoId.entries()) {
          if (url === value && ids.includes(id)) setValue('');
        }
      }
    });
    const tx = database.transaction('photos', 'readwrite');
    ids.forEach(id => tx.objectStore('photos').delete(id));
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    ids.forEach(id => {
      const url = objectUrlByPhotoId.get(id);
      if (url) {
        try { URL.revokeObjectURL(url); } catch (error) { /* ignore */ }
        objectUrlByPhotoId.delete(id);
      }
    });
    DB = next;
    await queuePersist(DB, { pruneOrphans: true });
    updateStorageMeter();
    showToast(`오래된 사진 ${ids.length}장을 정리했습니다.`);
    return ids.length;
  }

  async function estimateStorageBytes() {
    let total = 0;
    try {
      const database = await openIdb();
      const photos = await idbReq(database.transaction('photos', 'readonly').objectStore('photos').getAll());
      (photos || []).forEach(row => { total += row.blob ? row.blob.size : 0; });
      const text = clone(DB);
      walkPhotoFields(text, (owner, field, value, setValue) => setValue(isPhotoRef(value) ? value : ''));
      total += new Blob([JSON.stringify(text)]).size;
    } catch (error) {
      total = new Blob([JSON.stringify(DB)]).size;
    }
    if (navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        if (estimate?.usage) return { bytes: total, usage: estimate.usage, quota: estimate.quota || APPROX_STORAGE_LIMIT };
      } catch (error) { /* ignore */ }
    }
    return { bytes: total, usage: total, quota: APPROX_STORAGE_LIMIT };
  }


  function localDateString(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function shiftDate(dateString, days) {
    const [y, m, d] = dateString.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return localDateString(date);
  }

  function formatNumber(value, digits = null) {
    const options = digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
    return numberOr(value).toLocaleString('ko-KR', options);
  }

  function defaultEquipment(name = '내 장비') {
    return {
      id: uid('eq'),
      name: name || '내 장비',
      category: '지게차',
      type: '',
      number: '',
      status: 'active',
      createdAt: new Date().toISOString()
    };
  }

  function normalizeEquipment(item) {
    return {
      id: String(item?.id || uid('eq')),
      name: String(item?.name || '내 장비').slice(0, 60),
      category: String(item?.category || '기타').slice(0, 30),
      type: String(item?.type || '').slice(0, 40),
      number: String(item?.number || '').slice(0, 50),
      status: item?.status === 'idle' ? 'idle' : 'active',
      createdAt: String(item?.createdAt || item?.created_at || new Date().toISOString())
    };
  }

  function normalizeLogs(logs, equipmentId) {
    return (Array.isArray(logs) ? logs : [])
      .filter(item => item && isDateString(item.date))
      .map(item => ({ ...item, equipmentId: String(item.equipmentId || equipmentId) }));
  }

  function normalizeDayStatuses(items, equipmentId) {
    return (Array.isArray(items) ? items : [])
      .filter(item => item && isDateString(item.date))
      .map(item => ({
        id: String(item.id || uid('day')),
        equipmentId: String(item.equipmentId || equipmentId),
        date: String(item.date),
        status: item.status === 'holiday' ? 'holiday' : 'no-operation',
        memo: String(item.memo || '').slice(0, 300),
        createdAt: String(item.createdAt || new Date().toISOString()),
        updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString())
      }));
  }

  function normalizeSubmissions(submissions, equipmentId) {
    return (Array.isArray(submissions) ? submissions : [])
      .filter(item => item && isDateString(item.date))
      .map(item => ({
        id: String(item.id || uid('submit')),
        equipmentId: String(item.equipmentId || equipmentId),
        date: String(item.date),
        baseCode: String(item.baseCode || ''),
        revision: Math.max(1, Math.floor(numberOr(item.revision, 1))),
        sourceSignature: String(item.sourceSignature || ''),
        action: item.action === 'share' ? 'share' : 'copy',
        actionAt: String(item.actionAt || item.updatedAt || new Date().toISOString())
      }));
  }

  function normalizeOperations(items, equipmentId) {
    return (Array.isArray(items) ? items : []).filter(Boolean).map(item => ({
      id: String(item.id || uid('operation')),
      equipmentId: String(item.equipmentId || equipmentId),
      operatorId: String(item.operatorId || 'local-driver'),
      startedAt: String(item.startedAt || new Date().toISOString()),
      endedAt: item.endedAt ? String(item.endedAt) : '',
      startMeterValue: item.startMeterValue == null ? null : numberOr(item.startMeterValue),
      endMeterValue: item.endMeterValue == null ? null : numberOr(item.endMeterValue),
      memo: String(item.memo || '').slice(0, 500),
      status: item.status === 'completed' || item.endedAt ? 'completed' : 'active'
    }));
  }

  function normalizeInspections(items, equipmentId) {
    return (Array.isArray(items) ? items : []).filter(Boolean).map(item => ({
      id: String(item.id || uid('inspection')),
      equipmentId: String(item.equipmentId || equipmentId),
      date: isDateString(item.date) ? item.date : localDateString(new Date(item.completedAt || Date.now())),
      inspectorId: String(item.inspectorId || 'local-driver'),
      items: Array.isArray(item.items) ? item.items.map(check => ({ label: String(check.label || ''), status: ['normal', 'caution', 'abnormal'].includes(check.status) ? check.status : 'normal' })) : [],
      overallStatus: ['normal', 'caution', 'abnormal'].includes(item.overallStatus) ? item.overallStatus : 'normal',
      memo: String(item.memo || '').slice(0, 800),
      photo: String(item.photo || ''),
      completedAt: String(item.completedAt || new Date().toISOString())
    }));
  }

  function normalizeFaultReports(items, equipmentId) {
    return (Array.isArray(items) ? items : []).filter(Boolean).map(item => ({
      id: String(item.id || uid('fault')),
      equipmentId: String(item.equipmentId || equipmentId),
      symptom: String(item.symptom || '').slice(0, 300),
      severity: ['low', 'medium', 'high', 'critical'].includes(item.severity) ? item.severity : 'medium',
      operable: item.operable !== false,
      occurredAt: String(item.occurredAt || new Date().toISOString()),
      location: String(item.location || '').slice(0, 160),
      memo: String(item.memo || '').slice(0, 800),
      photo: String(item.photo || ''),
      reportedBy: String(item.reportedBy || 'local-driver'),
      createdAt: String(item.createdAt || new Date().toISOString()),
      resolvedAt: item.resolvedAt ? String(item.resolvedAt) : ''
    }));
  }


  function normalizeEquipmentDocs(docs, equipmentId) {
    return (Array.isArray(docs) ? docs : [])
      .map(item => ({
        id: String(item.id || uid('edoc')),
        equipmentId: String(item.equipmentId || equipmentId || ''),
        docType: String(item.docType || 'other'),
        label: String(item.label || item.docType || '서류'),
        photo: String(item.photo || ''),
        updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString()),
        createdAt: String(item.createdAt || new Date().toISOString())
      }))
      .filter(item => item.equipmentId && item.docType);
  }

  function migrateDatabase(source) {
    const raw = source && typeof source === 'object' ? source : {};
    let equipments = Array.isArray(raw.equipments) ? raw.equipments.map(normalizeEquipment) : [];
    if (!equipments.length) equipments = [defaultEquipment(raw.equipmentName || '내 장비')];
    const ids = new Set(equipments.map(item => item.id));
    const requestedCurrent = String(raw.currentEquipmentId || '');
    const currentEquipmentId = ids.has(requestedCurrent) ? requestedCurrent : equipments[0].id;
    return {
      version: DB_VERSION,
      currentEquipmentId,
      equipments,
      dailyLogs: normalizeLogs(raw.dailyLogs, currentEquipmentId),
      workLogs: normalizeLogs(raw.workLogs, currentEquipmentId),
      fuelLogs: normalizeLogs(raw.fuelLogs, currentEquipmentId),
      maintLogs: normalizeLogs(raw.maintLogs, currentEquipmentId),
      dayStatuses: normalizeDayStatuses(raw.dayStatuses, currentEquipmentId),
      submissions: normalizeSubmissions(raw.submissions, currentEquipmentId),
      operationSessions: normalizeOperations(raw.operationSessions, currentEquipmentId),
      inspections: normalizeInspections(raw.inspections, currentEquipmentId),
      faultReports: normalizeFaultReports(raw.faultReports, currentEquipmentId),
      equipmentDocs: normalizeEquipmentDocs(raw.equipmentDocs, currentEquipmentId),
      aiImageAnalyses: Array.isArray(raw.aiImageAnalyses) ? raw.aiImageAnalyses : [],
      aiCorrections: Array.isArray(raw.aiCorrections) ? raw.aiCorrections : []
    };
  }

  function loadDatabase() {
    // 동기 초기값. 실제 데이터는 boot()에서 IndexedDB/이관으로 채웁니다.
    return migrateDatabase({});
  }

  let DB = loadDatabase();
  let currentUsagePhoto = null;
  let currentUsageAnalysis = null;
  let pendingUsagePhoto = null;
  let usageCropRect = { x: 0.06, y: 0.38, width: 0.88, height: 0.36 };
  let usageCropStart = null;
  let usageAiFields = {
    hourMeter: { before: '', applied: null, status: '', candidates: [] },
    odometer: { before: '', applied: null, status: '', candidates: [] }
  };
  let currentWorkPhotos = [];
  let editingWorkId = null;
  let editingMaintId = null;
  let editingFuelId = null;
  let currentFuelReceipt = null;
  let currentInspectionPhoto = null;
  let currentFaultPhoto = null;
  let currentMaintenancePhoto = null;
  let usageTrendRange = 'week';
  let usageTrendType = 'usage';
  let photoSourceInputId = null;
  let toastTimer = null;
  let currentMode = 'record';
  let freePlanGuideSource = 'details';
  let deferredInstallPrompt = null;
  let installCompleted = false;
  const INSTALL_HANDOFF_PARAM = 'install';
  const INSTALL_HANDOFF_SOURCE_PARAM = 'from';
  const KAKAO_HANDOFF_GUARD = 'jangbion:kakao-chrome-handoff';
  const WORK_FIELD_DEFINITIONS = [
    ['type', '작업 유형'], ['start', '작업 시작'], ['end', '작업 종료'], ['hours', '작업시간'], ['photo', '사진'],
    ['place', '작업 장소'], ['project', '현장·프로젝트'], ['company', '작업 회사'], ['memo', '메모']
  ];

  function defaultWorkFieldLayout() {
    return { order: WORK_FIELD_DEFINITIONS.map(([id]) => id), hidden: [] };
  }

  function getWorkFieldLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem(WORK_FIELD_LAYOUT_KEY));
      const valid = new Set(WORK_FIELD_DEFINITIONS.map(([id]) => id));
      const order = Array.isArray(saved?.order) ? saved.order.filter(id => valid.has(id)) : [];
      valid.forEach(id => { if (!order.includes(id)) order.push(id); });
      const hidden = Array.isArray(saved?.hidden) ? saved.hidden.filter(id => valid.has(id)) : [];
      return { order, hidden };
    } catch (error) { return defaultWorkFieldLayout(); }
  }

  function saveWorkFieldLayout(layout) {
    try { localStorage.setItem(WORK_FIELD_LAYOUT_KEY, JSON.stringify(layout)); } catch (error) { console.warn(error); }
  }

  function applyWorkFieldLayout() {
    const layout = getWorkFieldLayout();
    const fields = $('work-form-fields');
    layout.order.forEach(id => {
      const field = fields.querySelector(`[data-work-field="${id}"]`);
      if (field) {
        field.classList.toggle('hidden', layout.hidden.includes(id));
        fields.appendChild(field);
      }
    });
    renderWorkFieldSettings(layout);
  }

  function renderWorkFieldSettings(layout = getWorkFieldLayout()) {
    const container = $('work-field-settings');
    container.replaceChildren(...layout.order.map((id, index) => {
      const [, label] = WORK_FIELD_DEFINITIONS.find(([fieldId]) => fieldId === id);
      const row = document.createElement('label'); row.className = 'work-field-setting';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !layout.hidden.includes(id); check.setAttribute('aria-label', `${label} 표시`);
      check.addEventListener('change', () => {
        layout.hidden = layout.hidden.filter(value => value !== id);
        if (!check.checked) layout.hidden.push(id);
        saveWorkFieldLayout(layout); applyWorkFieldLayout();
      });
      const name = document.createElement('span'); name.textContent = label;
      const up = document.createElement('button'); up.type = 'button'; up.className = 'work-field-move'; up.textContent = '↑'; up.disabled = index === 0; up.setAttribute('aria-label', `${label} 위로 이동`);
      up.addEventListener('click', event => { event.preventDefault(); [layout.order[index - 1], layout.order[index]] = [layout.order[index], layout.order[index - 1]]; saveWorkFieldLayout(layout); applyWorkFieldLayout(); });
      const down = document.createElement('button'); down.type = 'button'; down.className = 'work-field-move'; down.textContent = '↓'; down.disabled = index === layout.order.length - 1; down.setAttribute('aria-label', `${label} 아래로 이동`);
      down.addEventListener('click', event => { event.preventDefault(); [layout.order[index], layout.order[index + 1]] = [layout.order[index + 1], layout.order[index]]; saveWorkFieldLayout(layout); applyWorkFieldLayout(); });
      row.append(check, name, up, down); return row;
    }));
  }

  function commit(mutator, failureMessage = '저장 공간이 부족합니다. 오래된 사진을 정리하거나 백업 후 다시 시도해주세요.') {
    const next = clone(DB);
    try {
      mutator(next);
      next.version = DB_VERSION;
      DB = next;
      queuePersist(DB).then(() => updateStorageMeter());
      updateStorageMeter();
      return true;
    } catch (error) {
      console.error(error);
      showToast(failureMessage);
      return false;
    }
  }

  function currentEquipment() {
    return DB.equipments.find(item => item.id === DB.currentEquipmentId) || DB.equipments[0];
  }

  function equipmentLogs(list) {
    return list.filter(item => item.equipmentId === DB.currentEquipmentId);
  }

  function logsForEquipment(list, equipmentId) {
    return list.filter(item => item.equipmentId === equipmentId);
  }

  function selectedDate() {
    return $('dateSelect').value || localDateString();
  }

  function getBaselineForEquipment(date, equipmentId) {
    return logsForEquipment(DB.dailyLogs, equipmentId)
      .filter(item => item.date < date)
      .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  }

  function getBaseline(date) {
    return getBaselineForEquipment(date, DB.currentEquipmentId);
  }

  function dayStatusForEquipment(date, equipmentId) {
    return logsForEquipment(DB.dayStatuses, equipmentId).find(item => item.date === date) || null;
  }

  function selectedDayStatus() {
    return dayStatusForEquipment(selectedDate(), DB.currentEquipmentId);
  }

  function dayStatusLabel(record) {
    return record?.status === 'holiday' ? '휴무' : '무운행';
  }

  function clearDayStatusIn(next, equipmentId, date) {
    next.dayStatuses = next.dayStatuses.filter(item => !(item.equipmentId === equipmentId && item.date === date));
  }

  function computeEquipmentUsage(date, equipmentId) {
    const record = logsForEquipment(DB.dailyLogs, equipmentId).find(item => item.date === date);
    const baseline = getBaselineForEquipment(date, equipmentId);
    if (!record) return { hours: 0, km: 0, hourMeter: null, odometer: null, baseline };
    const baseHour = baseline ? numberOr(baseline.hourMeter) : numberOr(record.hourMeter);
    const baseDistance = baseline ? numberOr(baseline.odometer) : numberOr(record.odometer);
    return {
      hours: Math.max(0, +(numberOr(record.hourMeter) - baseHour).toFixed(1)),
      km: Math.max(0, +(numberOr(record.odometer) - baseDistance).toFixed(1)),
      hourMeter: numberOr(record.hourMeter),
      odometer: numberOr(record.odometer),
      baseline
    };
  }

  function computeDailyUsage(date) {
    return computeEquipmentUsage(date, DB.currentEquipmentId);
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function updateDayBadge() {
    const [y, m, d] = selectedDate().split('-').map(Number);
    $('dayBadge').textContent = DAYS[new Date(y, m - 1, d).getDay()];
  }

  function updateOnlineStatus() {
    const online = navigator.onLine;
    $('online-status').textContent = online ? '온라인' : '오프라인';
    $('online-status').style.background = online ? 'rgba(255,255,255,.18)' : 'rgba(245,158,11,.85)';
    $('offline-banner')?.classList.toggle('show', !online);
  }

  function setBrandTitle(suffix = '') {
    const title = $('app-title');
    const main = document.createElement('span'); main.className = 'brand-title-main'; main.textContent = '장비';
    const on = document.createElement('span'); on.className = 'brand-title-on'; on.textContent = '온';
    title.replaceChildren(main, on);
    if (suffix) { const extra = document.createElement('span'); extra.className = 'brand-title-suffix'; extra.textContent = suffix; title.append(extra); }
  }

  function switchMode(mode) {
    currentMode = mode === 'admin' ? 'admin' : 'record';
    document.querySelectorAll('.mode-button').forEach(button => button.classList.toggle('active', button.dataset.mode === currentMode));
    $('record-content').classList.toggle('hidden', currentMode !== 'record');
    $('admin-content').classList.toggle('hidden', currentMode !== 'admin');
    document.querySelector('.tab-bar').classList.toggle('hidden', currentMode !== 'record');
    $('equipment-select').disabled = currentMode === 'admin';
    $('equipment-select').style.opacity = currentMode === 'admin' ? '.65' : '1';
    setBrandTitle(currentMode === 'admin' ? '통합관리' : '');
    if (currentMode === 'admin') {
      loadAdminDashboard();
      document.title = '통합관리 | 장비온';
    } else {
      updateEquipmentUI();
      refreshActiveTab();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tabName}`));
    refreshActiveTab();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function refreshActiveTab() {
    const active = document.querySelector('.tab.active')?.dataset.tab || 'summary';
    if (active === 'summary') loadSummary();
    if (active === 'usage') loadUsageTab();
    if (active === 'work') loadWorkTab();
    if (active === 'fuel') loadFuelTab();
    if (active === 'maint') loadMaintTab();
    if (active === 'trend') loadHistoryTab();
  }

  function updateEquipmentUI() {
    const equipment = currentEquipment();
    const select = $('equipment-select');
    select.replaceChildren();
    DB.equipments.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.category} · ${item.name}`;
      option.selected = item.id === equipment.id;
      select.append(option);
    });
    $('summary-equipment-name').textContent = equipment.name;
    const meta = [equipment.category, equipment.type, equipment.number].filter(Boolean);
    $('summary-equipment-meta').textContent = meta.length ? meta.join(' · ') : '상세 정보를 등록해주세요.';
    setBrandTitle();
    document.title = `${equipment.name} | 장비온`;
  }

  function setTrend(elementId, difference, unit) {
    const element = $(elementId);
    if (Math.abs(difference) < 0.05) {
      element.textContent = '- 변동없음';
      element.className = 'kpi-diff flat';
      return;
    }
    element.textContent = `${difference > 0 ? '▲' : '▼'} ${Math.abs(difference).toFixed(1)} ${unit}`;
    element.className = `kpi-diff ${difference > 0 ? 'up' : 'down'}`;
  }

  function hashText(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    return (hash >>> 0).toString(36);
  }

  function equipmentShareCode(equipment) {
    const numberCode = String(equipment.number || '').replace(/[^0-9A-Za-z]/g, '').slice(-6).toUpperCase();
    if (numberCode) return numberCode;
    const idCode = String(equipment.id || '').replace(/[^0-9A-Za-z]/g, '').slice(-6).toUpperCase();
    return idCode || 'EQUIP';
  }

  function dailySubmissionData(date = selectedDate(), equipmentId = DB.currentEquipmentId) {
    const equipment = DB.equipments.find(item => item.id === equipmentId) || currentEquipment();
    const dayStatus = dayStatusForEquipment(date, equipment.id);
    const usageRecord = logsForEquipment(DB.dailyLogs, equipment.id).find(item => item.date === date) || null;
    const workRecords = logsForEquipment(DB.workLogs, equipment.id).filter(item => item.date === date);
    const workRecord = workRecords[0] || null;
    const workHours = workRecords.reduce((sum, item) => sum + numberOr(item.hours), 0);
    const fuelRecords = logsForEquipment(DB.fuelLogs, equipment.id).filter(item => item.date === date);
    const maintenanceRecords = logsForEquipment(DB.maintLogs, equipment.id).filter(item => item.date === date);
    const usage = computeEquipmentUsage(date, equipment.id);
    const source = {
      equipment: { id: equipment.id, name: equipment.name, category: equipment.category, type: equipment.type, number: equipment.number },
      date,
      dayStatus: dayStatus ? { status: dayStatus.status, memo: dayStatus.memo || '' } : null,
      usage: usageRecord ? { hourMeter: usageRecord.hourMeter, odometer: usageRecord.odometer, memo: usageRecord.memo || '' } : null,
      work: workRecords.map(item => ({ hours: item.hours, memo: item.memo || '', photoCount: (item.photos || []).length })),
      fuels: fuelRecords.map(item => ({ liters: item.liters, unitPrice: item.unitPrice, amount: item.amount, memo: item.memo || '', quick: Boolean(item.quick) })),
      maintenances: maintenanceRecords.map(item => ({ type: item.type || '', detail: item.detail || '', manager: item.manager || '', cost: item.cost, nextDate: item.nextDate || '' }))
    };
    return {
      equipment, date, dayStatus, usageRecord, workRecord, workRecords, workHours, fuelRecords, maintenanceRecords, usage,
      ready: Boolean(dayStatus || (usageRecord && workRecords.length)),
      sourceSignature: hashText(JSON.stringify(source))
    };
  }

  function prepareDailySubmission() {
    const data = dailySubmissionData();
    const existing = DB.submissions.find(item => item.equipmentId === data.equipment.id && item.date === data.date) || null;
    const baseCode = existing?.baseCode || `BN-${data.date.slice(2).replaceAll('-', '')}-${equipmentShareCode(data.equipment)}`;
    const revision = existing && existing.sourceSignature !== data.sourceSignature ? existing.revision + 1 : existing?.revision || 1;
    const displayCode = revision > 1 ? `${baseCode}-R${revision}` : baseCode;
    const fuelLiters = data.fuelRecords.reduce((sum, item) => sum + numberOr(item.liters), 0);
    const fuelAmount = data.fuelRecords.reduce((sum, item) => sum + numberOr(item.amount), 0);
    const quickFuel = data.fuelRecords.length > 0 && data.fuelRecords.every(item => item.quick);
    const maintenanceCost = data.maintenanceRecords.reduce((sum, item) => sum + numberOr(item.cost), 0);
    const maintenanceTypes = data.maintenanceRecords.map(item => item.type || '정비').join(', ');
    const memo = [data.dayStatus?.memo, ...data.workRecords.map(item => item.memo), data.usageRecord?.memo].filter(Boolean).join(' / ').slice(0, 240) || '없음';
    const equipmentDescription = [data.equipment.name, data.equipment.category, data.equipment.type].filter(Boolean).join(' · ');
    const fuelText = !data.fuelRecords.length
      ? '없음'
      : quickFuel ? '주유함 (상세 없음)' : `${formatNumber(fuelLiters, 1)}L / ${formatNumber(fuelAmount)}원`;
    const maintenanceText = !data.maintenanceRecords.length
      ? '없음'
      : `${maintenanceTypes} / ${formatNumber(maintenanceCost)}원`;
    const offLabel = data.dayStatus ? dayStatusLabel(data.dayStatus) : '';
    const usageHoursText = data.dayStatus ? `${offLabel} (0.0h)` : !data.usageRecord ? '미입력' : data.usage.baseline ? `${formatNumber(data.usage.hours, 1)}h` : '기준값 없음';
    const usageDistanceText = data.dayStatus ? `${offLabel} (0.0km)` : !data.usageRecord ? '미입력' : data.usage.baseline ? `${formatNumber(data.usage.km, 1)}km` : '기준값 없음';
    const lines = [
      '[장비온 장비기록]',
      '',
      `기록번호: ${displayCode}`,
      `날짜: ${data.date}`,
      `장비: ${equipmentDescription}`,
      `장비코드: ${equipmentShareCode(data.equipment)}`,
      '',
      '■ 사용',
      `운행상태: ${offLabel || '운행'}`,
      `아워메타: ${data.dayStatus ? '입력 없음 (최근 기록 유지)' : data.usageRecord ? `${formatNumber(data.usage.hourMeter, 1)}h` : '미입력'}`,
      `당일 사용: ${usageHoursText}`,
      `주행거리: ${usageDistanceText}`,
      '',
      '■ 작업',
      `작업: ${data.dayStatus ? `${offLabel} (0건 · 0.0h)` : data.workRecords.length ? `${data.workRecords.length}건 · ${formatNumber(data.workHours, 1)}h` : '미입력'}`,
      `메모: ${memo}`,
      '',
      '■ 주유',
      fuelText,
      '',
      '■ 정비',
      maintenanceText,
      '',
      '장비온에서 작성된 기록입니다.'
    ];
    return { ...data, existing, baseCode, revision, displayCode, text: lines.join('\n') };
  }

  function renderSubmissionCard() {
    const submission = prepareDailySubmission();
    const setState = (id, complete, completeText, missingText) => {
      const element = $(id);
      element.textContent = complete ? completeText : missingText;
      element.className = `submission-check-value ${complete ? 'complete' : 'missing'}`;
    };
    const offLabel = submission.dayStatus ? dayStatusLabel(submission.dayStatus) : '';
    setState('submission-usage-state', Boolean(submission.dayStatus || submission.usageRecord), offLabel || '입력 완료', '미입력');
    setState('submission-work-state', Boolean(submission.dayStatus || submission.workRecords.length), offLabel || `${submission.workRecords.length}건 입력`, '미입력');
    $('submission-fuel-state').textContent = submission.fuelRecords.length ? `${submission.fuelRecords.length}건 입력` : '없음 · 선택';
    $('submission-maint-state').textContent = submission.maintenanceRecords.length ? `${submission.maintenanceRecords.length}건 입력` : '없음 · 선택';
    const status = $('submission-status');
    const note = $('submission-note');
    const roomUrl = getSubmissionRoomUrl();
    if (!submission.existing) {
      status.textContent = '공유 필요'; status.className = 'submission-status pending';
      note.textContent = roomUrl
        ? '제출 시 내용 복사 후 등록된 제출방이 열립니다. 붙여넣어 전송하세요.'
        : '제출 시 내용을 복사합니다. 더보기 → 카카오 제출방에 오픈채팅 링크를 등록하면 방이 함께 열립니다.';
    } else if (submission.existing.sourceSignature !== submission.sourceSignature) {
      status.textContent = '다시 공유 필요'; status.className = 'submission-status changed';
      note.textContent = `저장 기록이 변경되었습니다. 수정본 ${submission.displayCode}을 다시 공유하세요.`;
    } else if (submission.existing.action === 'share') {
      status.textContent = '공유 열림'; status.className = 'submission-status opened';
      note.textContent = roomUrl
        ? '제출방을 열었습니다. 채팅에 붙여넣은 뒤 전송 여부를 확인하세요.'
        : '공유 화면을 열었습니다. 카카오톡에서 전송 여부를 확인하세요.';
    } else {
      status.textContent = '내용 복사됨'; status.className = 'submission-status copied';
      note.textContent = '복사한 내용을 카카오톡 제출방에 붙여넣어 전송하세요.';
    }
  }


  function getSubmissionRoomUrl() {
    try {
      const value = (localStorage.getItem(SUBMISSION_ROOM_KEY) || '').trim();
      return value || '';
    } catch (error) {
      return '';
    }
  }

  function isSafeSubmissionUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      return host === 'open.kakao.com' || host.endsWith('.kakao.com') || host === 'kakao.com';
    } catch (error) {
      return false;
    }
  }

  function refreshSubmissionRoomUi() {
    const input = $('inp-submission-room-url');
    const status = $('submission-room-status');
    const url = getSubmissionRoomUrl();
    if (input) input.value = url;
    if (status) {
      status.textContent = url
        ? `등록됨 · ${url.length > 42 ? `${url.slice(0, 42)}…` : url}`
        : '등록된 링크 없음 · 제출 시 복사만 하거나 기기 공유 화면을 사용합니다.';
    }
  }

  function saveSubmissionRoomUrl() {
    const input = $('inp-submission-room-url');
    const raw = (input?.value || '').trim();
    if (!raw) {
      showToast('제출방 링크를 입력해주세요.');
      return;
    }
    if (!isSafeSubmissionUrl(raw)) {
      showToast('카카오 오픈채팅 등 https://open.kakao.com 링크만 저장할 수 있습니다.');
      return;
    }
    try {
      localStorage.setItem(SUBMISSION_ROOM_KEY, raw);
      refreshSubmissionRoomUi();
      showToast('제출방 링크를 저장했습니다.');
    } catch (error) {
      showToast('링크를 저장하지 못했습니다.');
    }
  }

  function clearSubmissionRoomUrl() {
    try { localStorage.removeItem(SUBMISSION_ROOM_KEY); } catch (error) {}
    refreshSubmissionRoomUi();
    showToast('제출방 링크를 삭제했습니다.');
  }

  function openSubmissionRoom(url = getSubmissionRoomUrl()) {
    if (!url) return false;
    try {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        window.location.href = url;
      }
      return true;
    } catch (error) {
      try {
        window.location.href = url;
        return true;
      } catch (error2) {
        return false;
      }
    }
  }

  function openSubmissionModal() {
    const submission = prepareDailySubmission();
    $('submission-preview').value = submission.text;
    const warning = $('submission-warning');
    warning.textContent = submission.dayStatus
      ? `${dayStatusLabel(submission.dayStatus)} 기록이 완료되었습니다. 계기값은 최근 운행 기록을 그대로 이어갑니다.`
      : submission.ready
      ? '사용·작업 필수 기록이 모두 입력되었습니다.'
      : '사용 또는 작업 기록이 빠져 있습니다. 미입력 상태로도 공유할 수 있습니다.';
    warning.className = `submission-warning${submission.ready ? ' ready' : ''}`;
    $('submission-share-button').textContent = submission.ready ? '카카오톡 공유 열기' : '미입력 상태로 계속 공유';
    $('submission-modal').classList.remove('hidden');
  }

  function closeSubmissionModal() { $('submission-modal').classList.add('hidden'); }

  function markSubmissionAction(submission, action) {
    return commit(next => {
      next.submissions = next.submissions.filter(item => !(item.equipmentId === submission.equipment.id && item.date === submission.date));
      next.submissions.push({
        id: submission.existing?.id || uid('submit'), equipmentId: submission.equipment.id, date: submission.date,
        baseCode: submission.baseCode, revision: submission.revision, sourceSignature: submission.sourceSignature,
        action, actionAt: new Date().toISOString()
      });
    });
  }

  async function writeClipboardText(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (copied) return true;
    if (navigator.clipboard?.writeText) {
      return new Promise(resolve => {
        let finished = false;
        const complete = result => {
          if (finished) return;
          finished = true;
          resolve(result);
        };
        navigator.clipboard.writeText(text).then(() => complete(true)).catch(error => {
          console.warn('클립보드 API 사용 실패', error);
          complete(false);
        });
        setTimeout(() => complete(false), 1200);
      });
    }
    return false;
  }

  async function copyDailySubmission() {
    const submission = prepareDailySubmission();
    if (!await writeClipboardText(submission.text)) {
      const preview = $('submission-preview');
      if (!$('submission-modal').classList.contains('hidden')) { preview.focus(); preview.select(); }
      showToast('내용을 복사하지 못했습니다. 미리보기에서 직접 복사해주세요.');
      return false;
    }
    if (markSubmissionAction(submission, 'copy')) {
      renderSubmissionCard();
      $('submission-preview').value = prepareDailySubmission().text;
      showToast(getSubmissionRoomUrl() ? '복사했습니다. 제출방을 열고 붙여넣으세요.' : '복사했습니다. 카카오톡에 붙여넣으세요.');
      return true;
    }
    return false;
  }

  async function shareDailySubmission() {
    const submission = prepareDailySubmission();
    const roomUrl = getSubmissionRoomUrl();

    // 1) 항상 먼저 복사 (붙여넣기용)
    const copied = await writeClipboardText(submission.text);
    if (copied) {
      markSubmissionAction(submission, roomUrl ? 'share' : 'copy');
      renderSubmissionCard();
    }

    // 2) 제출방 등록 시: 방 열기 (반자동)
    if (roomUrl) {
      const opened = openSubmissionRoom(roomUrl);
      closeSubmissionModal();
      if (copied && opened) {
        showToast('복사했습니다. 열린 채팅에 붙여넣고 전송하세요.');
      } else if (copied) {
        showToast('복사했습니다. 카카오톡에서 제출방을 열고 붙여넣으세요.');
      } else {
        showToast('방 링크는 열었습니다. 미리보기에서 내용을 복사해 붙여넣으세요.');
        openSubmissionModal();
      }
      return;
    }

    // 3) 링크 없음: 기기 공유 시트 또는 복사만
    if (navigator.share) {
      try {
        await navigator.share({ title: '장비온 장비기록', text: submission.text });
        if (markSubmissionAction(submission, 'share')) {
          renderSubmissionCard();
          closeSubmissionModal();
          showToast('공유 화면을 열었습니다. 카카오톡을 선택해 전송하세요.');
        }
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }

    if (copied) {
      showToast('복사했습니다. 더보기 → 카카오 제출방에 링크를 등록하면 방이 함께 열립니다.');
    } else {
      showToast('복사에 실패했습니다. 미리보기에서 직접 복사해주세요.');
      openSubmissionModal();
    }
  }

  function recordListItem({ badge, badgeClass, detail, value, subvalue }) {
    const item = document.createElement('div');
    item.className = 'record-item';
    const left = document.createElement('div');
    left.className = 'record-left';
    const badgeElement = document.createElement('span');
    badgeElement.className = `badge ${badgeClass}`;
    badgeElement.textContent = badge;
    const detailElement = document.createElement('span');
    detailElement.style.cssText = 'font-size:.8rem;color:var(--sub)';
    detailElement.textContent = detail || '';
    left.append(badgeElement, detailElement);
    const right = document.createElement('div');
    right.className = 'record-right';
    const valueElement = document.createElement('div');
    valueElement.className = 'record-val';
    valueElement.textContent = value;
    right.append(valueElement);
    if (subvalue) {
      const sub = document.createElement('div');
      sub.className = 'record-cost';
      sub.textContent = subvalue;
      right.append(sub);
    }
    item.append(left, right);
    return item;
  }

  function svgIcon(name, className = 'ui-icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function equipmentIconName(category = '') {
    if (category.includes('굴착')) return 'excavator';
    if (category.includes('크레인')) return 'crane';
    if (category.includes('로더')) return 'loader';
    return 'equipment';
  }

  function formatTime(iso) {
    if (!iso) return '-';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function todayInspection(equipmentId = DB.currentEquipmentId) {
    const today = localDateString();
    return DB.inspections.filter(item => item.equipmentId === equipmentId && item.date === today)
      .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0] || null;
  }

  function latestUnresolvedFault(equipmentId = DB.currentEquipmentId) {
    return DB.faultReports.filter(item => item.equipmentId === equipmentId && !item.resolvedAt)
      .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))[0] || null;
  }

  function blockingFault(equipmentId = DB.currentEquipmentId) {
    return DB.faultReports.filter(item => item.equipmentId === equipmentId && !item.resolvedAt && (!item.operable || ['high', 'critical'].includes(item.severity)))
      .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))[0] || null;
  }

  function inspectionTemplate(category = '') {
    const common = ['누유 및 외관', '브레이크·조향', '경고등·계기판'];
    if (category.includes('굴착')) return [...common, '버킷·핀 상태', '트랙 장력', '유압 호스'];
    if (category.includes('크레인')) return [...common, '와이어로프', '아웃트리거', '안전장치'];
    if (category.includes('고소')) return [...common, '작업대 난간', '비상하강 장치', '배터리 상태'];
    if (category.includes('로더')) return [...common, '버킷 상태', '타이어 상태', '유압 장치'];
    return [...common, '포크·마스트', '타이어 상태', '후진 경보'];
  }

  function nextMaintenanceSchedule(equipmentId = DB.currentEquipmentId) {
    return DB.maintLogs.filter(item => item.equipmentId === equipmentId && isDateString(item.nextDate))
      .sort((a, b) => a.nextDate.localeCompare(b.nextDate))[0] || null;
  }

  function maintenanceDueText(equipmentId = DB.currentEquipmentId) {
    const schedule = nextMaintenanceSchedule(equipmentId);
    if (!schedule) return '등록된 다음 점검 일정이 없습니다.';
    const days = Math.ceil((new Date(`${schedule.nextDate}T00:00:00`) - new Date(`${localDateString()}T00:00:00`)) / 86400000);
    if (days < 0) return `${schedule.type || '정기점검'} 기한이 ${Math.abs(days)}일 지났습니다.`;
    if (days === 0) return `${schedule.type || '정기점검'} 예정일이 오늘입니다.`;
    return `${schedule.type || '정기점검'}까지 ${days}일 남았습니다.`;
  }

  function driverState() {
    const equipment = currentEquipment();
    const fault = blockingFault();
    const date = selectedDate();
    const today = date === localDateString();
    const dayStatus = selectedDayStatus();
    const selectedRecord = equipmentLogs(DB.dailyLogs).find(item => item.date === date);
    if (equipment.status === 'idle') return { key: 'restricted', badge: '운행 제한', action: 'equipment', button: '장비 상태 확인' };
    if (fault) return { key: 'restricted', badge: '운행 제한', action: 'fault', button: '고장 내용 확인' };
    if (dayStatus) return { key: 'idle', badge: dayStatusLabel(dayStatus), action: 'usage', button: '상태 확인·수정' };
    if (selectedRecord) return { key: 'available', badge: today ? '오늘 기록 완료' : '기록 완료', action: 'usage', button: '운행 기록 수정' };
    return { key: 'inspection', badge: '기록 필요', action: 'usage', button: '운행 기록 입력' };
  }

  function metricDefinitions(equipment, date) {
    const usage = computeEquipmentUsage(date, equipment.id);
    const works = logsForEquipment(DB.workLogs, equipment.id).filter(item => item.date === date);
    const workHours = works.reduce((sum, item) => sum + numberOr(item.hours), 0);
    const fuels = logsForEquipment(DB.fuelLogs, equipment.id).filter(item => item.date === date);
    const fuelLiters = fuels.reduce((sum, item) => sum + numberOr(item.liters), 0);
    const maintenances = logsForEquipment(DB.maintLogs, equipment.id).filter(item => item.date === date);
    const maintCost = maintenances.reduce((sum, item) => sum + numberOr(item.cost), 0);
    const dayStatus = dayStatusForEquipment(date, equipment.id);

    const fuelValue = !fuels.length
      ? '없음'
      : (fuels.every(item => item.quick) ? `완료 ${fuels.length}건` : `${formatNumber(fuelLiters, 1)} L`);
    const maintValue = !maintenances.length
      ? '없음'
      : (maintCost > 0 ? `${maintenances.length}건 · ${formatNumber(maintCost)}원` : `${maintenances.length}건`);

    return [
      { label: '운행시간', value: dayStatus ? dayStatusLabel(dayStatus) : `${usage.hours.toFixed(1)} 시간`, empty: !dayStatus && usage.hours <= 0 },
      { label: '주행거리', value: dayStatus ? '-' : `${usage.km.toFixed(1)} km`, empty: !dayStatus && usage.km <= 0 },
      { label: '작업 건수', value: dayStatus ? dayStatusLabel(dayStatus) : `${works.length} 건`, empty: !dayStatus && works.length === 0 },
      { label: '작업시간', value: dayStatus ? '-' : `${workHours.toFixed(1)} 시간`, empty: !dayStatus && workHours <= 0 },
      { label: '주유', value: fuelValue, empty: !fuels.length },
      { label: '정비', value: maintValue, empty: !maintenances.length }
    ];
  }

  function renderDriverMetrics() {
    const date = selectedDate();
    const dateLabel = date === localDateString() ? '오늘 기준' : `${date} 기준`;
    ['driver-metric-date', 'driver-metric-date-records'].forEach(id => {
      const el = $(id);
      if (el) el.textContent = dateLabel;
    });
    const cards = metricDefinitions(currentEquipment(), date).map(metric => {
      const card = document.createElement('div');
      card.className = 'submission-check';
      const label = document.createElement('div');
      label.className = 'submission-check-label';
      label.textContent = metric.label;
      const value = document.createElement('div');
      value.className = `submission-check-value${metric.empty ? ' metric-empty' : ' complete'}`;
      value.textContent = metric.value;
      card.append(label, value);
      return card;
    });
    ['driver-metrics', 'driver-metrics-records'].forEach(id => {
      const container = $(id);
      if (!container) return;
      container.replaceChildren(...cards.map(node => node.cloneNode(true)));
    });
  }

  function renderDriverRecordButtons() {
    const date = selectedDate();
    const equipmentId = DB.currentEquipmentId;
    const dayOff = Boolean(dayStatusForEquipment(date, equipmentId));
    const hasUsage = dayOff || equipmentLogs(DB.dailyLogs).some(item => item.date === date);
    const hasWork = logsForEquipment(DB.workLogs, equipmentId).some(record => record.date === date);
    const hasFuel = logsForEquipment(DB.fuelLogs, equipmentId).some(record => record.date === date);
    const hasMaint = logsForEquipment(DB.maintLogs, equipmentId).some(record => record.date === date);

    const setBtn = (id, icon, label) => {
      const button = $(id);
      if (!button) return;
      button.replaceChildren(svgIcon(icon), document.createTextNode(label));
    };

    // 홈 빠른 실행
    const opBtn = $('driver-operation-button');
    if (opBtn && (opBtn.dataset.action === 'usage' || !opBtn.dataset.action)) {
      setBtn('driver-operation-button', 'gauge', hasUsage ? '운행 기록 수정' : '운행 기록 입력');
    }
    setBtn('driver-work-button', 'clipboard', hasWork ? '작업 기록 수정' : '작업 기록 입력');
    setBtn('driver-fuel-button', 'fuel', hasFuel ? '주유 기록 수정' : '주유 기록 입력');
    setBtn('driver-maint-button', 'wrench', hasMaint ? '정비 기록 수정' : '정비 기록 입력');

    // 기록 탭 기록 입력 (동일 규칙)
    setBtn('records-usage-button', 'gauge', hasUsage ? '운행 기록 수정' : '운행 기록 입력');
    setBtn('records-work-button', 'clipboard', hasWork ? '작업 기록 수정' : '작업 기록 입력');
    setBtn('records-fuel-button', 'fuel', hasFuel ? '주유 기록 수정' : '주유 기록 입력');
    setBtn('records-maint-button', 'wrench', hasMaint ? '정비 기록 수정' : '정비 기록 입력');
  }


  const SERVICE_TRACK_TYPES = {
    dpf: { type: 'DPF 후처리', label: 'DPF 후처리', home: true, record: true, alert: true },
    grease: { type: '구리스 주입', label: '구리스 주입', home: true, record: true, alert: true },
    engineOil: { type: '엔진오일 교환', label: '엔진오일', home: false, record: true, alert: true },
    missionOil: { type: '미션오일 교환', label: '미션오일', home: false, record: true, alert: true },
    hydraulicOil: { type: '대우오일 교환', label: '대우오일', home: false, record: true, alert: true },
    filter: { type: '필터 교환', label: '필터 교환', home: false, record: true, alert: true },
    tireFront: { type: '앞타이어 교체', label: '앞타이어 교체', home: false, record: true, alert: true },
    tireRear: { type: '뒷타이어 교체', label: '뒷타이어 교체', home: false, record: true, alert: true }
  };
  const SERVICE_HOME_KEYS = Object.keys(SERVICE_TRACK_TYPES).filter(key => SERVICE_TRACK_TYPES[key].home);
  const SERVICE_RECORD_KEYS = Object.keys(SERVICE_TRACK_TYPES).filter(key => SERVICE_TRACK_TYPES[key].record);
  const SERVICE_ALERT_KEYS = Object.keys(SERVICE_TRACK_TYPES).filter(key => SERVICE_TRACK_TYPES[key].alert);
  const MAINT_TYPE_ALIASES = {
    '앞타이어 교체': ['앞타이어 교체', '앞 타이어 교체', '앞타이어', '전타이어 교체'],
    '뒷타이어 교체': ['뒷타이어 교체', '뒤타이어 교체', '뒷 타이어 교체', '뒤 타이어 교체', '뒷타이어', '뒤타이어', '후타이어 교체']
  };

  function normalizeMaintType(value) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  }

  function maintTypeMatches(stored, expected) {
    const actual = normalizeMaintType(stored);
    const target = normalizeMaintType(expected);
    if (!actual || !target) return false;
    if (actual === target) return true;
    return (MAINT_TYPE_ALIASES[target] || []).includes(actual);
  }

  function lastMaintByType(type, equipmentId = DB.currentEquipmentId) {
    return logsForEquipment(DB.maintLogs, equipmentId)
      .filter(item => maintTypeMatches(item.type, type))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  }

  function daysBetweenDates(fromDate, toDate) {
    if (!isDateString(fromDate) || !isDateString(toDate)) return null;
    const a = new Date(`${fromDate}T00:00:00`);
    const b = new Date(`${toDate}T00:00:00`);
    return Math.round((b - a) / 86400000);
  }

  /** 실시일 다음날~기준일까지 운행기록 시간·거리 합 */
  function usageTotalsAfterDate(serviceDate, equipmentId = DB.currentEquipmentId, throughDate = localDateString()) {
    const logs = logsForEquipment(DB.dailyLogs, equipmentId)
      .filter(item => isDateString(item.date) && item.date > serviceDate && item.date <= throughDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    let hours = 0;
    let km = 0;
    let daysWithUsage = 0;
    logs.forEach(item => {
      const usage = computeEquipmentUsage(item.date, equipmentId);
      if (usage.hours > 0 || usage.km > 0) daysWithUsage += 1;
      hours += usage.hours;
      km += usage.km;
    });
    return {
      hours: +hours.toFixed(1),
      km: +km.toFixed(1),
      daysWithUsage,
      logCount: logs.length
    };
  }

  function buildServiceIntervalAlert(key, equipmentId = DB.currentEquipmentId, asOf = localDateString()) {
    const conf = SERVICE_TRACK_TYPES[key];
    if (!conf) return null;
    const last = lastMaintByType(conf.type, equipmentId);
    if (!last) {
      return {
        key,
        level: 'none',
        title: conf.label,
        meta: '기록 없음',
        detail: `정비 탭에서 「${conf.type}」 실시일을 남기면 D+n·운행합계를 표시합니다.`,
        serviceDate: null,
        dayOffset: null,
        hours: 0,
        km: 0
      };
    }
    const dayOffset = daysBetweenDates(last.date, asOf);
    const totals = usageTotalsAfterDate(last.date, equipmentId, asOf);
    const dLabel = dayOffset == null ? '-' : dayOffset === 0 ? 'D+0 (당일)' : `D+${dayOffset}`;
    let level = 'ok';
    if (dayOffset != null && dayOffset >= 1 && dayOffset <= 7) level = 'warn';
    const nextDate = isDateString(last.nextDate) ? last.nextDate : '';
    let nextNote = '';
    if (nextDate) {
      const daysToNext = daysBetweenDates(asOf, nextDate);
      if (daysToNext != null && daysToNext <= 0) {
        level = 'warn';
        nextNote = `다음 점검 ${nextDate} · 기한 경과`;
      } else if (daysToNext != null && daysToNext <= 7) {
        level = 'warn';
        nextNote = `다음 점검 ${nextDate} · D-${daysToNext}`;
      } else {
        nextNote = `다음 점검 ${nextDate}`;
      }
    }
    const meta = [dLabel, `운행 ${formatNumber(totals.hours, 1)}h · ${formatNumber(totals.km, 1)}km`, nextNote].filter(Boolean).join(' · ');
    const detail = `기준일 ${last.date} 이후 운행기록 합계 (실시 당일 제외). 운행 입력 ${totals.logCount}일`;
    return {
      key,
      level,
      title: conf.label,
      meta,
      detail,
      serviceDate: last.date,
      dayOffset,
      hours: totals.hours,
      km: totals.km
    };
  }

  function renderServiceAlertList(container, keys, options = {}) {
    if (!container) return;
    const asOf = selectedDate();
    const compact = Boolean(options.compact);
    const alerts = keys.map(key => buildServiceIntervalAlert(key, DB.currentEquipmentId, asOf)).filter(Boolean);
    container.replaceChildren(...alerts.map(alert => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const levelClass = alert.level === 'warn' ? 'warn' : alert.level === 'none' ? 'none' : 'ok';
      btn.className = `service-alert ${levelClass}`;
      btn.onclick = () => openMaintForServiceType(SERVICE_TRACK_TYPES[alert.key]?.type);
      const title = document.createElement('div');
      title.className = 'service-alert-title';
      title.textContent = alert.title;
      const meta = document.createElement('div');
      meta.className = 'service-alert-meta';
      meta.textContent = alert.meta;
      btn.append(title, meta);
      if (!compact) {
        const detail = document.createElement('div');
        detail.className = 'service-alert-detail';
        detail.textContent = alert.detail;
        btn.append(detail);
      } else if (alert.serviceDate) {
        const detail = document.createElement('div');
        detail.className = 'service-alert-detail';
        detail.textContent = `기준 ${alert.serviceDate}`;
        btn.append(detail);
      }
      return btn;
    }));
  }

  function openMaintForServiceType(type) {
    closeAlertsHub();
    closeSettings();
    switchTab('maint');
    startNewMaintRecord();
    if (type && $('inp-maint-type')) $('inp-maint-type').value = type;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderRecordServiceIntervalAlerts() {
    renderServiceAlertList($('equipment-service-interval-alerts'), SERVICE_RECORD_KEYS, { compact: false });
  }

  function collectAlertItems() {
    const items = [];
    const submission = prepareDailySubmission();
    if (!submission.dayStatus) {
      if (!submission.usageRecord) {
        items.push({
          id: 'missing-usage',
          level: 'warn',
          title: '운행 기록 미입력',
          meta: '오늘 계기·운행 기록이 없습니다',
          detail: '운행 기록에서 입력하세요.',
          action: () => { closeAlertsHub(); switchTab('usage'); }
        });
      }
      if (!submission.workRecords.length) {
        items.push({
          id: 'missing-work',
          level: 'warn',
          title: '작업 기록 미입력',
          meta: '오늘 작업 기록이 없습니다',
          detail: '작업 탭에서 입력하세요.',
          action: () => { closeAlertsHub(); switchTab('work'); }
        });
      }
    }
    return items;
  }

  function getAlertsBadgeCount() {
    return collectAlertItems().filter(item => item.level === 'warn' || item.level === 'none').length;
  }

  function renderAlertsBadge() {
    const n = getAlertsBadgeCount();
    const label = n > 9 ? '9+' : String(n);
    ['alerts-badge', 'alerts-badge-header'].forEach(id => {
      const el = $(id);
      if (!el) return;
      if (n <= 0) {
        el.classList.add('hidden');
        el.textContent = '';
        el.setAttribute('aria-hidden', 'true');
      } else {
        el.classList.remove('hidden');
        el.textContent = label;
        el.setAttribute('aria-hidden', 'false');
      }
    });
  }

  function renderAlertsHub() {
    const list = $('alerts-hub-list');
    if (!list) return;
    const items = collectAlertItems();
    if (!items.length) {
      list.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'alerts-hub-empty';
      empty.textContent = '운행·작업 기록이 모두 입력되어 있습니다.';
      list.append(empty);
      return;
    }
    list.replaceChildren(...items.map(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const levelClass = item.level === 'warn' ? 'warn' : item.level === 'none' ? 'none' : 'ok';
      btn.className = `service-alert ${levelClass}`;
      btn.addEventListener('click', () => item.action && item.action());
      const title = document.createElement('div');
      title.className = 'service-alert-title';
      title.textContent = item.title;
      const meta = document.createElement('div');
      meta.className = 'service-alert-meta';
      meta.textContent = item.meta;
      const detail = document.createElement('div');
      detail.className = 'service-alert-detail';
      detail.textContent = item.detail || '';
      btn.append(title, meta, detail);
      return btn;
    }));
  }

  function openAlertsHub() {
    renderAlertsHub();
    renderAlertsBadge();
    $('alerts-hub-modal')?.classList.remove('hidden');
  }

  function closeAlertsHub() {
    $('alerts-hub-modal')?.classList.add('hidden');
  }

  function renderDriverStatusOverview() {
    const date = selectedDate();
    const equipmentId = DB.currentEquipmentId;
    const fuels = logsForEquipment(DB.fuelLogs, equipmentId).filter(item => item.date === date);
    const maintenances = logsForEquipment(DB.maintLogs, equipmentId).filter(item => item.date === date);
    const fuelLiters = fuels.reduce((sum, item) => sum + numberOr(item.liters), 0);
    const fuelAmount = fuels.reduce((sum, item) => sum + numberOr(item.amount), 0);
    const quickFuel = fuels.length > 0 && fuels.every(item => item.quick);

    if (!fuels.length) {
      if ($('driver-fuel-status-value')) $('driver-fuel-status-value').textContent = '기록 없음';
      if ($('driver-fuel-status-detail')) $('driver-fuel-status-detail').textContent = '주유 기록을 추가할 수 있습니다.';
    } else if (quickFuel) {
      if ($('driver-fuel-status-value')) $('driver-fuel-status-value').textContent = `주유 완료 · ${fuels.length}건`;
      if ($('driver-fuel-status-detail')) $('driver-fuel-status-detail').textContent = '상세 수량 없이 완료로 기록했습니다.';
    } else {
      if ($('driver-fuel-status-value')) $('driver-fuel-status-value').textContent = `${formatNumber(fuelLiters, 1)}L · ${fuels.length}건`;
      if ($('driver-fuel-status-detail')) $('driver-fuel-status-detail').textContent = fuelAmount > 0 ? `총 ${formatNumber(fuelAmount)}원` : '금액 정보 없음';
    }

    const maintenanceCost = maintenances.reduce((sum, item) => sum + numberOr(item.cost), 0);
    if (maintenances.length) {
      const types = maintenances.map(item => item.type || '정비').join(', ');
      if ($('driver-maint-status-value')) $('driver-maint-status-value').textContent = `${maintenances.length}건 · ${formatNumber(maintenanceCost)}원`;
      if ($('driver-maint-status-detail')) $('driver-maint-status-detail').textContent = types;
    } else {
      if ($('driver-maint-status-value')) $('driver-maint-status-value').textContent = '당일 기록 없음';
      if ($('driver-maint-status-detail')) $('driver-maint-status-detail').textContent = maintenanceDueText();
    }

    // 홈 상태 필 (상태·빠른 실행 중심)
    const statusDate = $('home-status-date');
    if (statusDate) statusDate.textContent = date === localDateString() ? '오늘 기준' : `${date} 기준`;
    const dayStatus = logsForEquipment(DB.dayStatuses, equipmentId).find(item => item.date === date);
    const hasUsage = Boolean(dayStatus) || logsForEquipment(DB.dailyLogs, equipmentId).some(item => item.date === date);
    const hasWork = Boolean(dayStatus) || logsForEquipment(DB.workLogs, equipmentId).some(item => item.date === date);
    const setPill = (id, done, labelDone, labelMissing, optional = false) => {
      const el = $(id);
      if (!el) return;
      el.classList.remove('is-done', 'is-missing', 'is-optional');
      if (optional && !done) {
        el.classList.add('is-optional');
        el.textContent = labelMissing;
      } else if (done) {
        el.classList.add('is-done');
        el.textContent = labelDone;
      } else {
        el.classList.add('is-missing');
        el.textContent = labelMissing;
      }
    };
    if ($('home-status-usage')) {
      setPill('home-status-usage', hasUsage, '사용 · 기록됨', '사용 · 미입력');
      setPill('home-status-work', hasWork, '작업 · 기록됨', '작업 · 미입력');
      setPill('home-status-fuel', fuels.length > 0, `주유 · ${fuels.length}건`, '주유 · 없음', true);
      setPill('home-status-maint', maintenances.length > 0, `정비 · ${maintenances.length}건`, '정비 · 없음', true);
    }
  }

  function recentActivities() {
    const equipmentId = DB.currentEquipmentId;
    const activities = [];
    logsForEquipment(DB.dayStatuses, equipmentId).forEach(item => activities.push({ icon: 'calendar', title: `${dayStatusLabel(item)} 기록`, detail: `${item.date} · 운행 없음`, time: item.updatedAt || item.createdAt }));
    logsForEquipment(DB.workLogs, equipmentId).forEach(item => activities.push({ icon: 'clipboard', title: item.project || item.place || '작업 기록', detail: `${item.date} · ${numberOr(item.hours).toFixed(1)}시간`, time: item.updatedAt || item.createdAt }));
    logsForEquipment(DB.fuelLogs, equipmentId).forEach(item => activities.push({ icon: 'fuel', title: item.quick ? '주유 완료 체크' : '주유 기록', detail: `${item.date}${item.quick ? '' : ` · ${numberOr(item.liters).toFixed(1)}L`}`, time: item.createdAt }));
    logsForEquipment(DB.maintLogs, equipmentId).forEach(item => activities.push({ icon: 'wrench', title: item.type || '정비 기록', detail: item.date, time: item.createdAt }));
    DB.inspections.filter(item => item.equipmentId === equipmentId).forEach(item => activities.push({ icon: 'shield', title: '일일 안전 점검', detail: `${item.date} · ${item.overallStatus === 'normal' ? '정상' : '이상 확인'}`, time: item.completedAt }));
    DB.faultReports.filter(item => item.equipmentId === equipmentId).forEach(item => activities.push({ icon: 'alert', title: '고장 신고', detail: item.symptom || '내용 없음', time: item.occurredAt }));
    return activities.filter(item => item.time).sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 5);
  }

  function renderRecentActivities() {
    const container = $('driver-recent-list');
    if (!container) return;
    const activities = recentActivities();
    if (!activities.length) return renderEmpty(container, 'clock', '아직 기록이 없습니다. 빠른 실행으로 첫 기록을 남겨보세요.');
    container.replaceChildren(...activities.map(item => {
      const row = document.createElement('div'); row.className = 'recent-activity';
      const icon = document.createElement('div'); icon.className = 'activity-icon'; icon.append(svgIcon(item.icon));
      const copy = document.createElement('div');
      const title = document.createElement('div'); title.className = 'activity-title'; title.textContent = item.title;
      const detail = document.createElement('div'); detail.className = 'activity-detail'; detail.textContent = item.detail;
      copy.append(title, detail);
      const time = document.createElement('time'); time.className = 'activity-time'; time.textContent = formatTime(item.time);
      row.append(icon, copy, time); return row;
    }));
  }

  function renderEmpty(container, icon, message) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const iconElement = document.createElement('div');
    iconElement.className = 'empty-icon';
    iconElement.append(svgIcon(icon));
    empty.append(iconElement, document.createTextNode(message));
    container.replaceChildren(empty);
  }

  function loadSummary() {
    updateEquipmentUI();
    const equipment = currentEquipment();
    const state = driverState();
    const visual = $('driver-equipment-visual');
    visual.replaceChildren(svgIcon(equipmentIconName(equipment.category), 'ui-icon large equipment-hero-icon'));
    $('driver-health-badge').className = `health-badge health-${state.key}`;
    $('driver-health-badge').textContent = state.badge;
    const operationButton = $('driver-operation-button');
    operationButton.dataset.action = state.action;
    operationButton.className = `btn operation-primary ${state.key === 'restricted' ? 'restricted' : ''}`;
    operationButton.replaceChildren(svgIcon(state.action === 'fault' ? 'alert' : state.action === 'equipment' ? 'settings' : 'gauge'), document.createTextNode(state.button));
    renderDriverMetrics();
    renderDriverStatusOverview();
    renderAlertsBadge();
    renderDriverRecordButtons();
    syncFuelQuickUI();
    renderSubmissionCard();
  }

  function handleOperationPrimaryAction() {
    const action = $('driver-operation-button').dataset.action;
    if (action === 'equipment') return openEquipmentManager();
    if (action === 'fault') return openFaultModal();
    switchTab('usage');
  }

  function openDayStatusPanel() {
    switchMode('record');
    switchTab('usage');
    setTimeout(() => $('day-status-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  function openInspectionModal() {
    const equipment = currentEquipment();
    $('inspection-equipment-label').textContent = `${equipment.name} · ${equipment.category || '장비'} 점검표`;
    $('inspection-checklist').replaceChildren(...inspectionTemplate(equipment.category).map((label, index) => {
      const row = document.createElement('div'); row.className = 'checklist-item';
      const copy = document.createElement('label'); copy.className = 'checklist-label'; copy.setAttribute('for', `inspection-status-${index}`); copy.textContent = label;
      const select = document.createElement('select'); select.id = `inspection-status-${index}`; select.className = 'form-select inspection-status'; select.dataset.label = label;
      [['normal', '정상'], ['caution', '주의'], ['abnormal', '이상']].forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); });
      row.append(copy, select); return row;
    }));
    $('inspection-memo').value = '';
    currentInspectionPhoto = null;
    showPhotoPreview('inspection-photo-preview', 'inspection-photo-img', null);
    $('inspection-modal').classList.remove('hidden');
  }

  function closeInspectionModal() { $('inspection-modal').classList.add('hidden'); }

  function saveInspection() {
    const items = Array.from(document.querySelectorAll('.inspection-status')).map(select => ({ label: select.dataset.label, status: select.value }));
    if (!items.length) return showToast('점검 항목을 불러오지 못했습니다.');
    const overallStatus = items.some(item => item.status === 'abnormal') ? 'abnormal' : items.some(item => item.status === 'caution') ? 'caution' : 'normal';
    const record = { id: uid('inspection'), equipmentId: DB.currentEquipmentId, date: localDateString(), items, overallStatus, memo: $('inspection-memo').value.trim().slice(0, 500), photo: currentInspectionPhoto, completedAt: new Date().toISOString() };
    if (commit(next => next.inspections.push(record))) {
      closeInspectionModal();
      showToast(overallStatus === 'abnormal' ? '이상 항목이 있어 운행이 제한됩니다.' : '일일 안전 점검을 저장했습니다.');
      loadSummary();
    }
  }

  function localDateTimeInput(date = new Date()) {
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function openFaultModal() {
    const latest = latestUnresolvedFault();
    $('fault-symptom').value = latest?.symptom || '';
    $('fault-severity').value = latest?.severity || 'medium';
    $('fault-operable').value = latest ? String(latest.operable) : 'true';
    $('fault-time').value = latest?.occurredAt ? localDateTimeInput(new Date(latest.occurredAt)) : localDateTimeInput();
    $('fault-location').value = latest?.location || '';
    $('fault-memo').value = latest?.memo || '';
    currentFaultPhoto = latest?.photo || null;
    showPhotoPreview('fault-photo-preview', 'fault-photo-img', currentFaultPhoto);
    $('fault-resolve-button').classList.toggle('hidden', !latest);
    $('fault-modal').classList.remove('hidden');
  }

  function closeFaultModal() { $('fault-modal').classList.add('hidden'); }

  function saveFaultReport() {
    const symptom = $('fault-symptom').value.trim();
    if (!symptom) return showToast('고장 증상을 입력해주세요.');
    const time = new Date($('fault-time').value || Date.now());
    const record = { id: uid('fault'), equipmentId: DB.currentEquipmentId, symptom: symptom.slice(0, 200), severity: $('fault-severity').value, operable: $('fault-operable').value === 'true', occurredAt: Number.isNaN(time.getTime()) ? new Date().toISOString() : time.toISOString(), location: $('fault-location').value.trim().slice(0, 120), memo: $('fault-memo').value.trim().slice(0, 800), photo: currentFaultPhoto, resolvedAt: null, createdAt: new Date().toISOString() };
    if (commit(next => next.faultReports.push(record))) {
      closeFaultModal(); showToast(!record.operable || ['high', 'critical'].includes(record.severity) ? '고장 신고를 저장하고 운행을 제한했습니다.' : '고장 신고를 저장했습니다.'); loadSummary();
    }
  }

  function resolveLatestFault() {
    const fault = latestUnresolvedFault();
    if (!fault) return closeFaultModal();
    if (commit(next => { const target = next.faultReports.find(item => item.id === fault.id); if (target) target.resolvedAt = new Date().toISOString(); })) {
      closeFaultModal(); showToast('고장 조치 완료로 변경했습니다.'); loadSummary();
    }
  }

  function openMoreMenu() { $('more-modal').classList.remove('hidden'); }
  function closeMoreMenu() { $('more-modal').classList.add('hidden'); }
  function openAlertComingSoon() { openAlertsHub(); }
  function closeAlertComingSoon() { closeAlertsHub(); }
  function openPhotoSourcePicker(inputId) {
    photoSourceInputId = inputId;
    const modal = $('photo-source-modal');
    if (modal) {
      modal.classList.add('elevated');
      modal.classList.remove('hidden');
    }
  }
  function closePhotoSourcePicker() {
    photoSourceInputId = null;
    const modal = $('photo-source-modal');
    if (modal) modal.classList.add('hidden');
  }

  function choosePhotoSource(source) {
    const inputId = photoSourceInputId;
    const input = inputId ? $(inputId) : null;
    if (!input) return closePhotoSourcePicker();
    if (source === 'camera') input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    closePhotoSourcePicker();
    // 장비 모달 위에 떠 있던 피커를 닫은 뒤 파일 선택을 연다
    setTimeout(() => {
      try { input.click(); } catch (error) { showToast('사진 선택을 열지 못했습니다.'); }
    }, 50);
  }

  function navigateBottom(target) {
    document.querySelectorAll('[data-bottom-nav]').forEach(button => button.classList.toggle('active', button.dataset.bottomNav === target));
    if (target === 'home') { switchMode('record'); switchTab('summary'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (target === 'equipment') { switchMode('record'); openEquipmentManager(); }
    if (target === 'records') { switchMode('record'); switchTab('trend'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (target === 'alerts') openAlertsHub();
    if (target === 'more') openMoreMenu();
  }

  function loadUsageTab() {
    const date = selectedDate();
    const baseline = getBaseline(date);
    const existing = equipmentLogs(DB.dailyLogs).find(item => item.date === date);
    $('prev-record-date').textContent = baseline ? `최근 기록 · ${baseline.date}` : '최근 계기 기록 없음';
    $('prev-hm-val').textContent = baseline ? `${formatNumber(baseline.hourMeter)} h` : '기록 없음';
    $('prev-odo-val').textContent = baseline ? `${formatNumber(baseline.odometer)} km` : '기록 없음';
    $('inp-hm').value = existing?.hourMeter ?? '';
    $('inp-odo').value = existing?.odometer ?? '';
    $('inp-memo').value = existing?.memo || '';
    currentUsagePhoto = existing?.photo || null;
    currentUsageAnalysis = null;
    resetUsageAiFields();
    showPhotoPreview('usage-photo-preview', 'usage-photo-img', currentUsagePhoto);
    setUsageAiPanel();
    renderDayStatusControls();
    updateUsagePreview();
  }

  function renderDayStatusControls() {
    const record = selectedDayStatus();
    const label = $('day-status-current');
    label.textContent = record ? `${selectedDate()} · ${dayStatusLabel(record)} 처리 완료` : '운행하지 않은 날만 선택하세요.';
    label.className = `day-status-current${record ? ' active' : ''}`;
    $('btn-day-holiday').classList.toggle('active', record?.status === 'holiday');
    $('btn-day-no-operation').classList.toggle('active', record?.status === 'no-operation');
    $('btn-clear-day-status').classList.toggle('hidden', !record);
    const disabled = Boolean(record);
    ['inp-hm', 'inp-odo', 'inp-memo', 'btn-usage-photo-pick', 'btn-save-usage'].forEach(id => { $(id).disabled = disabled; });
    $('usage-entry-fields').classList.toggle('day-status-disabled', disabled);
  }

  function markDayStatus(status) {
    if (!['holiday', 'no-operation'].includes(status)) return;
    const date = selectedDate();
    if (date > localDateString()) return showToast('미래 날짜는 휴무·무운행으로 기록할 수 없습니다.');
    const hasUsage = equipmentLogs(DB.dailyLogs).some(item => item.date === date);
    const hasWork = equipmentLogs(DB.workLogs).some(item => item.date === date);
    if ((hasUsage || hasWork) && !confirm('이 날짜에 운행 또는 작업 기록이 있습니다. 휴무·무운행으로 바꾸면 해당 운행·작업 기록을 삭제합니다. 계속할까요?')) return;
    const existing = selectedDayStatus();
    const record = {
      id: existing?.id || uid('day'), equipmentId: DB.currentEquipmentId, date, status, memo: '',
      createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    if (commit(next => {
      next.dailyLogs = next.dailyLogs.filter(item => !(item.equipmentId === DB.currentEquipmentId && item.date === date));
      next.workLogs = next.workLogs.filter(item => !(item.equipmentId === DB.currentEquipmentId && item.date === date));
      clearDayStatusIn(next, DB.currentEquipmentId, date);
      next.dayStatuses.push(record);
    })) {
      currentUsagePhoto = null;
      currentWorkPhotos = [];
      loadUsageTab();
      loadSummary();
      showToast(`${dayStatusLabel(record)}로 기록했습니다. 다음 운행일은 최근 계기 기록을 이어갑니다.`);
    }
  }

  function clearSelectedDayStatus() {
    const record = selectedDayStatus();
    if (!record || !confirm(`${dayStatusLabel(record)} 기록을 해제할까요?`)) return;
    if (commit(next => clearDayStatusIn(next, DB.currentEquipmentId, selectedDate()))) {
      loadUsageTab();
      loadSummary();
      showToast('휴무·무운행 상태를 해제했습니다.');
    }
  }

  function updateUsagePreview() {
    const hourMeter = Number.parseFloat($('inp-hm').value);
    const odometer = Number.parseFloat($('inp-odo').value);
    const preview = $('calc-preview');
    if (!Number.isFinite(hourMeter) || !Number.isFinite(odometer)) {
      preview.classList.remove('show');
      return;
    }
    const baseline = getBaseline(selectedDate());
    $('calc-hours').textContent = `${Math.max(0, hourMeter - numberOr(baseline?.hourMeter, hourMeter)).toFixed(1)} h`;
    $('calc-km').textContent = `${Math.max(0, odometer - numberOr(baseline?.odometer, odometer)).toFixed(1)} km`;
    preview.classList.add('show');
  }

  function showPhotoPreview(previewId, imageId, dataUrl) {
    const preview = $(previewId);
    if (!dataUrl) {
      preview.style.display = 'none';
      $(imageId).removeAttribute('src');
      return;
    }
    $(imageId).src = dataUrl;
    preview.style.display = 'block';
  }

  function compressImage(file, maxDimension = 800, quality = 0.5) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('이미지 파일이 아닙니다.'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
        image.onload = () => {
          let { width, height } = image;
          const ratio = Math.min(1, maxDimension / Math.max(width, height));
          width = Math.max(1, Math.round(width * ratio));
          height = Math.max(1, Math.round(height * ratio));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          let output = '';
          try {
            output = canvas.toDataURL('image/webp', quality);
            if (!output.startsWith('data:image/webp')) output = canvas.toDataURL('image/jpeg', quality);
          } catch (error) {
            output = canvas.toDataURL('image/jpeg', quality);
          }
          resolve(output);
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function compressImageDataUrl(source, maxDimension = 800, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onerror = () => reject(new Error('사진을 불러오지 못했습니다.'));
      image.onload = () => {
        const ratio = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      image.src = source;
    });
  }

  function isSecretMode() {
    try { return localStorage.getItem(SECRET_MODE_KEY) === '1'; }
    catch (error) { return false; }
  }

  function applySecretModeUi() {
    document.body.classList.toggle('secret-mode', isSecretMode());
    if (!isSecretMode()) setUsageAiPanel();
  }

  function setSecretMode(on, options = {}) {
    const next = Boolean(on);
    if (isSecretMode() === next) {
      applySecretModeUi();
      return;
    }
    try { localStorage.setItem(SECRET_MODE_KEY, next ? '1' : '0'); }
    catch (error) { /* ignore */ }
    applySecretModeUi();
    updateAppVersionLabel();
    if (options.silent) return;
    showToast(next ? '시크릿 모드를 켰습니다. AI 계기판 분석은 이 기기에서만 사용합니다.' : '시크릿 모드를 껐습니다.');
  }

  function consumeSecretQuery() {
    const params = new URLSearchParams(location.search);
    if (!params.has('secret')) return;
    setSecretMode(params.get('secret') === '1', { silent: true });
    params.delete('secret');
    const next = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`;
    history.replaceState({}, '', next);
  }

  function setUsageAiPanel(title = '', detail = '', warning = false, dateLine = '') {
    const panel = $('usage-ai-panel');
    if (!panel) return;
    if (!title) {
      panel.classList.add('hidden');
      return;
    }
    $('usage-ai-title').textContent = title;
    $('usage-ai-detail').textContent = detail;
    $('usage-ai-detail').classList.toggle('warning', warning);
    const dateEl = $('usage-ai-date');
    if (dateEl) {
      dateEl.textContent = dateLine;
      dateEl.classList.toggle('hidden', !dateLine);
    }
    panel.classList.remove('hidden');
  }

  function usageAiHintId(field) {
    return field === 'hourMeter' ? 'hm-ai-status' : 'odo-ai-status';
  }

  function setFieldAiHint(field, text = '계기판 표시값', kind = '') {
    const el = $(usageAiHintId(field));
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ai-applied', kind === 'auto');
    el.classList.toggle('ai-review', kind === 'review');
    el.classList.toggle('ai-user', kind === 'user');
  }

  function resetUsageAiFields() {
    usageAiFields = {
      hourMeter: { before: '', applied: null, status: '', candidates: [] },
      odometer: { before: '', applied: null, status: '', candidates: [] }
    };
    setFieldAiHint('hourMeter');
    setFieldAiHint('odometer');
  }

  function uniqueAnalysisNumbers(values) {
    const seen = new Set();
    const list = [];
    (Array.isArray(values) ? values : [values]).forEach(value => {
      const number = analysisNumber(value);
      if (number == null || seen.has(number)) return;
      seen.add(number);
      list.push(number);
    });
    return list;
  }

  function handleUsageFieldInput(field) {
    updateUsagePreview();
    const input = $(field === 'hourMeter' ? 'inp-hm' : 'inp-odo');
    const state = usageAiFields[field];
    if (!input || !state || (!state.status && state.applied == null)) return;
    const raw = input.value.trim();
    if (raw === '') {
      input.value = state.before;
      state.applied = null;
      state.status = '';
      setFieldAiHint(field);
      updateUsagePreview();
      return;
    }
    const value = analysisNumber(raw);
    if (state.applied != null && value === state.applied) {
      if (state.status === 'auto') setFieldAiHint(field, 'AI 자동입력', 'auto');
      else if (state.status === 'review') setFieldAiHint(field, '확인 필요', 'review');
      return;
    }
    if (state.applied != null && value != null && value !== state.applied) {
      setFieldAiHint(field, '사용자 수정', 'user');
    }
  }

  function usageCropImageBox() {
    const stage = $('usage-crop-stage').getBoundingClientRect();
    const image = $('usage-crop-image');
    const naturalWidth = image.naturalWidth || 1;
    const naturalHeight = image.naturalHeight || 1;
    const scale = Math.min(stage.width / naturalWidth, stage.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    return {
      left: stage.left + (stage.width - width) / 2,
      top: stage.top + (stage.height - height) / 2,
      width,
      height
    };
  }

  function renderUsageCropSelection() {
    const stage = $('usage-crop-stage').getBoundingClientRect();
    const box = usageCropImageBox();
    const selection = $('usage-crop-selection');
    selection.style.left = `${box.left - stage.left + usageCropRect.x * box.width}px`;
    selection.style.top = `${box.top - stage.top + usageCropRect.y * box.height}px`;
    selection.style.width = `${usageCropRect.width * box.width}px`;
    selection.style.height = `${usageCropRect.height * box.height}px`;
  }

  function usageCropPoint(event) {
    const box = usageCropImageBox();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
    };
  }

  function openUsageCropper(dataUrl) {
    pendingUsagePhoto = dataUrl;
    usageCropRect = { x: 0.06, y: 0.38, width: 0.88, height: 0.36 };
    const image = $('usage-crop-image');
    image.onload = renderUsageCropSelection;
    image.src = dataUrl;
    $('usage-crop-modal').classList.remove('hidden');
  }

  function closeUsageCropper() {
    pendingUsagePhoto = null;
    usageCropStart = null;
    $('usage-crop-modal').classList.add('hidden');
  }

  async function cropUsagePhoto() {
    const source = pendingUsagePhoto;
    if (!source) throw new Error('자를 사진이 없습니다.');
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('사진을 불러오지 못했습니다.'));
      image.src = source;
    });
    const x = Math.round(image.naturalWidth * usageCropRect.x);
    const y = Math.round(image.naturalHeight * usageCropRect.y);
    const width = Math.max(1, Math.round(image.naturalWidth * usageCropRect.width));
    const height = Math.max(1, Math.round(image.naturalHeight * usageCropRect.height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, x, y, width, height, 0, 0, width, height);
    return compressImageDataUrl(canvas.toDataURL('image/jpeg', 0.9));
  }

  function analysisNumber(value) {
    return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  }

  function applyMeterSuggestion(field, value, confidence, needsReview, candidates) {
    const input = $(field === 'hourMeter' ? 'inp-hm' : 'inp-odo');
    const state = usageAiFields[field];
    const score = numberOr(confidence, 0);
    const ambiguous = candidates.length > 1;
    state.before = input.value;
    state.candidates = candidates;
    state.applied = null;
    const shouldFill = !needsReview && !ambiguous && value != null && score >= 75;
    if (shouldFill) {
      input.value = value;
      state.applied = value;
      if (score >= 95) {
        state.status = 'auto';
        setFieldAiHint(field, 'AI 자동입력', 'auto');
      } else {
        state.status = 'review';
        setFieldAiHint(field, '확인 필요', 'review');
      }
      const unit = field === 'hourMeter' ? 'h' : 'km';
      const label = field === 'hourMeter' ? '시간계' : '거리계';
      return { filled: true, text: `${label} ${formatNumber(value)} ${unit}` };
    }
    const candidateText = candidates.length
      ? `후보 ${candidates.map(item => formatNumber(item)).join(' / ')} · 직접 입력하거나 다시 촬영해주세요.`
      : '숫자를 확실히 읽지 못했습니다. 직접 입력하거나 다시 촬영해주세요.';
    state.status = 'hold';
    setFieldAiHint(field, candidateText, 'review');
    return { filled: false, text: candidateText };
  }

  function applyUsageAnalysis(result) {
    const fields = result?.fields || {};
    const confidence = result?.fieldConfidence || {};
    const baseline = getBaseline(selectedDate());
    const warnings = [];
    const hourMeter = analysisNumber(fields.hourMeter);
    const odometer = analysisNumber(fields.odometer);
    const hourCandidates = uniqueAnalysisNumbers([...(result?.hourMeterCandidates || []), hourMeter]);
    const odometerCandidates = uniqueAnalysisNumbers([...(result?.odometerCandidates || []), odometer]);
    let hourNeedsReview = Boolean(result?.needsReview) || hourCandidates.length > 1;
    let odometerNeedsReview = Boolean(result?.needsReview) || odometerCandidates.length > 1;

    if (hourMeter != null) {
      if (baseline && hourMeter < numberOr(baseline.hourMeter)) { hourNeedsReview = true; warnings.push('시간계가 이전 기록보다 작습니다.'); }
      if (baseline && hourMeter - numberOr(baseline.hourMeter) > 24) { hourNeedsReview = true; warnings.push('당일 사용시간이 24시간을 넘습니다.'); }
    }
    if (odometer != null) {
      if (baseline && odometer < numberOr(baseline.odometer)) { odometerNeedsReview = true; warnings.push('거리계가 이전 기록보다 작습니다.'); }
    }
    if (hourCandidates.length > 1) warnings.push('시간계 후보가 둘 이상입니다.');
    if (odometerCandidates.length > 1) warnings.push('거리계 후보가 둘 이상입니다.');

    const hourResult = applyMeterSuggestion('hourMeter', hourMeter, confidence.hourMeter, hourNeedsReview, hourCandidates);
    const odometerResult = applyMeterSuggestion('odometer', odometer, confidence.odometer, odometerNeedsReview, odometerCandidates);
    const displayDate = isDateString(fields.displayDate) ? fields.displayDate : '';
    const dateMismatch = Boolean(displayDate && displayDate !== selectedDate());
    if (dateMismatch) warnings.push('사진 날짜와 기록 날짜가 다릅니다.');
    const dateLine = displayDate
      ? (dateMismatch ? `사진 날짜 ${displayDate} · 사진 날짜와 기록 날짜가 다릅니다` : `사진 날짜 ${displayDate} · 선택한 기록 날짜와 일치`)
      : '';
    const needsReview = hourNeedsReview || odometerNeedsReview;
    const suggestions = [hourResult.filled ? hourResult.text : '', odometerResult.filled ? odometerResult.text : ''].filter(Boolean);
    currentUsageAnalysis = {
      id: uid('analysis'),
      fields: { hourMeter, odometer, displayDate },
      fieldConfidence: confidence,
      rawText: String(result?.rawText || ''),
      needsReview
    };
    updateUsagePreview();
    const holdNotes = [hourResult.filled ? '' : hourResult.text, odometerResult.filled ? '' : odometerResult.text].filter(Boolean);
    const detail = [suggestions.join(' · '), warnings.join(' '), holdNotes.join(' ')].filter(Boolean).join(' · ');
    const reviewTitle = usageAiFields.hourMeter.status === 'review' || usageAiFields.odometer.status === 'review' || needsReview || dateMismatch;
    if (suggestions.length) {
      setUsageAiPanel(reviewTitle ? 'AI 분석 결과 · 확인 필요' : 'AI 자동입력 완료', detail, reviewTitle, dateLine);
    } else {
      setUsageAiPanel('AI 분석 결과 · 직접 확인 필요', detail || '숫자를 확실히 읽지 못했습니다. 직접 입력하거나 다시 촬영해주세요.', true, dateLine);
    }
  }

  async function analyzeUsagePhoto(photo) {
    if (!isSecretMode()) return;
    if (!navigator.onLine) return setUsageAiPanel('사진 분석을 사용할 수 없습니다', '오프라인 상태입니다. 사진은 저장되고 직접 입력할 수 있습니다.', true);
    setUsageAiPanel('계기판 숫자 확인 중…', '시간계와 거리계를 분석하고 있습니다.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/ai/analyze-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ context: 'usage', equipmentId: DB.currentEquipmentId, date: selectedDate(), image: photo })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '사진 분석에 실패했습니다.');
      applyUsageAnalysis(payload);
    } catch (error) {
      const message = error.name === 'AbortError' ? '분석 시간이 초과되었습니다.' : error.message;
      setUsageAiPanel('사진 분석을 사용할 수 없습니다', `${message} 직접 입력할 수 있습니다.`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function applyUsagePhoto(photo, options = {}) {
    currentUsagePhoto = photo;
    currentUsageAnalysis = null;
    resetUsageAiFields();
    showPhotoPreview('usage-photo-preview', 'usage-photo-img', currentUsagePhoto);
    if (options.analyze === false || !isSecretMode()) {
      if (isSecretMode() && options.analyze === false) {
        setUsageAiPanel('사진만 저장됩니다', '자르기를 취소해 원본 사진을 유지했습니다. 시간계·거리계는 직접 입력하세요.', true);
      }
      return;
    }
    await analyzeUsagePhoto(currentUsagePhoto);
  }

  function saveUsage() {
    const hourMeter = Number.parseFloat($('inp-hm').value);
    const odometer = Number.parseFloat($('inp-odo').value);
    if (!Number.isFinite(hourMeter) || !Number.isFinite(odometer) || hourMeter < 0 || odometer < 0) {
      showToast('시간계와 거리계를 올바르게 입력해주세요.');
      return;
    }
    const baseline = getBaseline(selectedDate());
    if (baseline && (hourMeter < numberOr(baseline.hourMeter) || odometer < numberOr(baseline.odometer))) {
      if (!confirm('이전 계기값보다 작은 값입니다. 계기판 교체 또는 초기화 기록이라면 계속 저장하세요.')) return;
    }
    const date = selectedDate();
    const existing = equipmentLogs(DB.dailyLogs).find(item => item.date === date);
    const record = {
      id: existing?.id || uid('usage'), equipmentId: DB.currentEquipmentId, date,
      hourMeter, odometer, memo: $('inp-memo').value.trim().slice(0, 500), photo: currentUsagePhoto,
      createdAt: existing?.createdAt || existing?.created_at || new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const analysis = currentUsageAnalysis;
    const saved = commit(next => {
      clearDayStatusIn(next, DB.currentEquipmentId, date);
      const index = next.dailyLogs.findIndex(item => item.id === record.id);
      if (index >= 0) next.dailyLogs[index] = record; else next.dailyLogs.push(record);
      if (analysis) {
        next.aiImageAnalyses.push({
          id: analysis.id, equipmentId: record.equipmentId, usageRecordId: record.id, recordType: 'usage',
          photoRef: record.photo || '',
          rawText: analysis.rawText, extractedData: analysis.fields, fieldConfidence: analysis.fieldConfidence,
          needsReview: analysis.needsReview, userConfirmed: true, createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString()
        });
        ['hourMeter', 'odometer'].forEach(fieldName => {
          const aiValue = analysis.fields[fieldName];
          const userValue = record[fieldName];
          if (aiValue != null && aiValue !== userValue) next.aiCorrections.push({ id: uid('correction'), analysisId: analysis.id, fieldName, aiValue, userValue, createdAt: new Date().toISOString() });
        });
      }
    });
    if (saved) {
      currentUsageAnalysis = null;
      showToast('사용 기록을 저장했습니다.');
      navigateBottom('home');
    }
  }

  function renderWorkPhotoGrid() {
    const grid = $('work-photo-grid');
    grid.replaceChildren(...currentWorkPhotos.map((source, index) => {
      const thumb = document.createElement('div');
      thumb.className = 'photo-thumb';
      const image = document.createElement('img');
      image.src = source;
      image.alt = `작업 사진 ${index + 1}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '✕';
      button.addEventListener('click', () => removeWorkPhoto(index));
      thumb.append(image, button);
      return thumb;
    }));
  }

  function removeWorkPhoto(index) {
    currentWorkPhotos.splice(index, 1);
    renderWorkPhotoGrid();
  }

  function workRecordsForSelectedDate() {
    return equipmentLogs(DB.workLogs)
      .filter(item => item.date === selectedDate())
      .sort((a, b) => String(a.createdAt || a.created_at || '').localeCompare(String(b.createdAt || b.created_at || '')));
  }

  function renderWorkRecordList() {
    const records = workRecordsForSelectedDate();
    const container = $('work-record-list');
    if (!records.length) {
      container.replaceChildren(Object.assign(document.createElement('span'), { className: 'hint', textContent: '저장된 작업이 없습니다. 첫 작업을 입력하세요.' }));
      return;
    }
    container.replaceChildren(...records.map((record, index) => {
      const row = document.createElement('div'); row.className = 'work-record-item';
      const copy = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = `${index + 1}. ${record.workType || '작업'} · ${numberOr(record.hours).toFixed(1)}시간`;
      const detail = document.createElement('span');
      detail.textContent = [
        record.startTime && record.endTime ? `${record.startTime}~${record.endTime}` : '',
        record.company ? `작업 회사 ${record.company}` : '작업 회사 미입력',
        record.memo ? `메모 ${record.memo}` : ''
      ].filter(Boolean).join(' · ');
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'work-record-edit'; edit.textContent = '수정'; edit.addEventListener('click', () => editWorkRecord(record.id));
      copy.append(title, detail); row.append(copy, edit); return row;
    }));
  }

  function fillWorkForm(record = null) {
    $('inp-work-type').value = record?.workType || '일반 작업';
    $('inp-work-start').value = record?.startTime || '';
    $('inp-work-end').value = record?.endTime || '';
    $('inp-work-place').value = record?.place || '';
    $('inp-work-project').value = record?.project || '';
    $('inp-work-company').value = record?.company || '';
    $('inp-work-hours').value = record?.hours ?? '';
    $('inp-work-memo').value = record?.memo || '';
    currentWorkPhotos = clone(record?.photos || (record?.photo ? [record.photo] : []));
    renderWorkPhotoGrid();
    $('btn-save-work').textContent = record ? '작업 기록 수정 저장' : '작업 기록 저장';
  }

  function loadWorkTab() {
    const record = editingWorkId ? workRecordsForSelectedDate().find(item => item.id === editingWorkId) : null;
    if (!record) editingWorkId = null;
    fillWorkForm(record || null);
    renderWorkRecordList();
  }

  function startNewWorkRecord() {
    editingWorkId = null;
    loadWorkTab();
  }

  function editWorkRecord(id) {
    editingWorkId = id;
    loadWorkTab();
  }

  function saveWork() {
    const startTime = $('inp-work-start').value;
    const endTime = $('inp-work-end').value;
    let hours = Number.parseFloat($('inp-work-hours').value);
    if (!Number.isFinite(hours) && startTime && endTime) {
      const [startHour, startMinute] = startTime.split(':').map(Number);
      const [endHour, endMinute] = endTime.split(':').map(Number);
      let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
      if (minutes < 0) minutes += 1440;
      hours = Math.round(minutes / 6) / 10;
    }
    const hoursVisible = !$('work-form-fields').querySelector('[data-work-field="hours"]').classList.contains('hidden');
    if (!Number.isFinite(hours) && !hoursVisible) hours = 0;
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
      showToast('작업시간을 0~24시간 범위로 입력해주세요.');
      return;
    }
    const date = selectedDate();
    const existing = editingWorkId ? equipmentLogs(DB.workLogs).find(item => item.id === editingWorkId) : null;
    const record = {
      id: existing?.id || uid('work'), equipmentId: DB.currentEquipmentId, date, hours,
      workType: $('inp-work-type').value, startTime, endTime,
      place: $('inp-work-place').value.trim().slice(0, 120), project: $('inp-work-project').value.trim().slice(0, 120), company: $('inp-work-company').value.trim().slice(0, 120),
      memo: $('inp-work-memo').value.trim().slice(0, 500), photos: currentWorkPhotos.slice(0, MAX_WORK_PHOTOS),
      createdAt: existing?.createdAt || existing?.created_at || new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const saved = commit(next => {
      clearDayStatusIn(next, DB.currentEquipmentId, date);
      const index = next.workLogs.findIndex(item => item.id === record.id);
      if (index >= 0) next.workLogs[index] = record; else next.workLogs.push(record);
    });
    if (saved) {
      const count = equipmentLogs(DB.workLogs).filter(item => item.date === date).length;
      editingWorkId = null;
      showToast(`작업 기록을 저장했습니다. 오늘 ${count}건입니다.`);
      navigateBottom('home');
    }
  }

  function isFuelQuickChecked() {
    return equipmentLogs(DB.fuelLogs).some(item => item.date === selectedDate() && item.quick);
  }

  function setFuelFormDisabled(disabled) {
    ['inp-liters', 'inp-unit-price', 'inp-fuel-meter', 'inp-fuel-provider', 'inp-fuel-memo', 'btn-fuel-receipt-pick', 'btn-save-fuel'].forEach(id => $(id).disabled = disabled);
    $('btn-save-fuel').style.opacity = disabled ? '.5' : '1';
  }

  function syncFuelQuickUI() {
    const checked = isFuelQuickChecked();
    ['chk-fuel-quick', 'chk-fuel-quick-summary'].map($).filter(Boolean).forEach(input => { input.checked = checked; });
    setFuelFormDisabled(checked);
  }

  function toggleFuelQuick(checked) {
    const date = selectedDate();
    const saved = commit(next => {
      next.fuelLogs = next.fuelLogs.filter(item => !(item.equipmentId === DB.currentEquipmentId && item.date === date && item.quick));
      if (checked) next.fuelLogs.push({
        id: uid('fuel'), equipmentId: DB.currentEquipmentId, date, liters: 0, unitPrice: 0, amount: 0,
        memo: '', quick: true, createdAt: new Date().toISOString()
      });
    });
    if (saved) {
      syncFuelQuickUI();
      loadSummary();
      showToast(checked ? '오늘 주유함으로 기록했습니다.' : '주유 체크를 해제했습니다.');
    }
  }

  function fillFuelForm(record = null) {
    const isQuick = Boolean(record?.quick);
    ['chk-fuel-quick', 'chk-fuel-quick-summary'].map($).filter(Boolean).forEach(input => { input.checked = isQuick; });
    setFuelFormDisabled(isQuick);
    $('inp-liters').value = record && !isQuick ? (record.liters ?? '') : '';
    $('inp-unit-price').value = record && !isQuick ? (record.unitPrice ?? '') : '';
    $('inp-fuel-meter').value = record && record.meterValue != null && record.meterValue !== '' ? record.meterValue : '';
    $('inp-fuel-provider').value = record?.provider || '';
    $('inp-fuel-memo').value = record?.memo || '';
    currentFuelReceipt = record?.receipt || null;
    showPhotoPreview('fuel-receipt-preview', 'fuel-receipt-img', currentFuelReceipt);
    $('btn-save-fuel').textContent = record && !isQuick ? '주유 기록 수정 저장' : '주유 기록 저장';
    updateFuelPreview();
  }

  function loadFuelTab() {
    const editing = editingFuelId ? equipmentLogs(DB.fuelLogs).find(item => item.id === editingFuelId) : null;
    if (editingFuelId && !editing) editingFuelId = null;
    if (editing) {
      fillFuelForm(editing);
      return;
    }
    syncFuelQuickUI();
    fillFuelForm(null);
    const latest = equipmentLogs(DB.fuelLogs).filter(item => item.date === selectedDate() && !item.quick).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    currentFuelReceipt = latest?.receipt || null;
    showPhotoPreview('fuel-receipt-preview', 'fuel-receipt-img', currentFuelReceipt);
    updateFuelPreview();
  }

  function updateFuelPreview() {
    const liters = Number.parseFloat($('inp-liters').value);
    const unitPrice = Number.parseFloat($('inp-unit-price').value);
    if (Number.isFinite(liters) && Number.isFinite(unitPrice)) {
      $('calc-fuel-amt').textContent = `${formatNumber(Math.round(liters * unitPrice))}원`;
      $('fuel-preview').classList.add('show');
    } else $('fuel-preview').classList.remove('show');
  }

  function saveFuel() {
    const liters = Number.parseFloat($('inp-liters').value);
    const unitPrice = numberOr($('inp-unit-price').value);
    if (!Number.isFinite(liters) || liters <= 0 || unitPrice < 0) {
      showToast('주유량을 올바르게 입력해주세요.');
      return;
    }
    const existing = editingFuelId ? equipmentLogs(DB.fuelLogs).find(item => item.id === editingFuelId) : null;
    const record = {
      id: existing?.id || uid('fuel'), equipmentId: DB.currentEquipmentId, date: selectedDate(), liters, unitPrice,
      amount: Math.round(liters * unitPrice), meterValue: $('inp-fuel-meter').value === '' ? null : numberOr($('inp-fuel-meter').value),
      provider: $('inp-fuel-provider').value.trim().slice(0, 120), receipt: currentFuelReceipt,
      memo: $('inp-fuel-memo').value.trim().slice(0, 300),
      quick: false, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    if (commit(next => {
      const index = next.fuelLogs.findIndex(item => item.id === record.id);
      if (index >= 0) next.fuelLogs[index] = record; else next.fuelLogs.push(record);
    })) {
      editingFuelId = null;
      $('inp-liters').value = '';
      $('inp-unit-price').value = '';
      $('inp-fuel-meter').value = '';
      $('inp-fuel-provider').value = '';
      $('inp-fuel-memo').value = '';
      currentFuelReceipt = null;
      showPhotoPreview('fuel-receipt-preview', 'fuel-receipt-img', null);
      $('btn-save-fuel').textContent = '주유 기록 저장';
      updateFuelPreview();
      showToast(existing ? '주유 기록을 수정했습니다.' : '주유 기록을 저장했습니다.');
      navigateBottom('home');
    }
  }


  function maintRecordsForSelectedDate() {
    return equipmentLogs(DB.maintLogs)
      .filter(item => item.date === selectedDate())
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  function renderMaintRecordList() {
    const records = maintRecordsForSelectedDate();
    const container = $('maint-record-list');
    if (!container) return;
    if (!records.length) {
      container.replaceChildren(Object.assign(document.createElement('span'), { className: 'hint', textContent: '저장된 정비가 없습니다. 첫 정비를 입력하세요.' }));
      return;
    }
    container.replaceChildren(...records.map((record, index) => {
      const row = document.createElement('div'); row.className = 'work-record-item';
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${index + 1}. ${record.type || '정비'}${numberOr(record.cost) > 0 ? ` · ${formatNumber(record.cost)}원` : ''}`;
      const detail = document.createElement('span');
      detail.textContent = [record.manager, record.detail || record.nextDate || '상세 없음'].filter(Boolean).join(' · ');
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'work-record-edit'; edit.textContent = '수정';
      edit.addEventListener('click', () => editMaintRecord(record.id));
      copy.append(title, detail); row.append(copy, edit); return row;
    }));
  }

  function ensureMaintTypeOption(type) {
    const select = $('inp-maint-type');
    if (!select || !type) return;
    if ([...select.options].some(option => option.value === type)) return;
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    select.append(option);
  }

  function fillMaintForm(record = null) {
    ensureMaintTypeOption(record?.type);
    $('inp-maint-type').value = record?.type || '';
    $('inp-maint-detail').value = record?.detail || '';
    $('inp-maint-manager').value = record?.manager || '';
    $('inp-maint-cost').value = record?.cost ?? '';
    $('inp-maint-next-date').value = record?.nextDate || '';
    currentMaintenancePhoto = record?.photo || null;
    showPhotoPreview('maint-photo-preview', 'maint-photo-img', currentMaintenancePhoto);
    $('btn-save-maint').textContent = record ? '정비 기록 수정 저장' : '정비 기록 저장';
  }

  function loadMaintTab() {
    const record = editingMaintId ? maintRecordsForSelectedDate().find(item => item.id === editingMaintId) : null;
    if (!record) editingMaintId = null;
    fillMaintForm(record || null);
    renderMaintRecordList();
  }

  function startNewMaintRecord() {
    editingMaintId = null;
    loadMaintTab();
  }

  function editMaintRecord(id) {
    editingMaintId = id;
    loadMaintTab();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function saveMaintenance() {
    const type = normalizeMaintType($('inp-maint-type').value);
    if (!type) {
      showToast('정비 종류를 선택해주세요.');
      return;
    }
    const cost = numberOr($('inp-maint-cost').value);
    if (cost < 0) {
      showToast('비용을 올바르게 입력해주세요.');
      return;
    }
    const existing = editingMaintId ? equipmentLogs(DB.maintLogs).find(item => item.id === editingMaintId) : null;
    const record = {
      id: existing?.id || uid('maint'),
      equipmentId: DB.currentEquipmentId,
      date: selectedDate(),
      type,
      detail: $('inp-maint-detail').value.trim().slice(0, 800),
      manager: $('inp-maint-manager').value.trim().slice(0, 80),
      cost,
      nextDate: $('inp-maint-next-date').value || '',
      photo: currentMaintenancePhoto,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (commit(next => {
      if (existing) next.maintLogs = next.maintLogs.map(item => item.id === existing.id ? record : item);
      else next.maintLogs.push(record);
    })) {
      editingMaintId = null;
      fillMaintForm(null);
      renderMaintRecordList();
      renderRecordServiceIntervalAlerts();
      showToast(existing ? '정비 기록을 수정했습니다.' : '정비 기록을 저장했습니다.');
      renderAlertsBadge();
    }
  }

  const trendMetadata = {
    usage: { metric: '운행시간', unit: 'h' },
    work: { metric: '작업시간', unit: 'h' },
    fuel: { metric: '주유량', unit: 'L' },
    maint: { metric: '정비비', unit: '원' }
  };

  function trendDates() {
    const anchor = new Date(`${selectedDate()}T00:00:00`);
    if (usageTrendRange === 'month') {
      const days = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
      return Array.from({ length: days }, (_, index) => `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`);
    }
    return Array.from({ length: 7 }, (_, index) => shiftDate(selectedDate(), index - 6));
  }

  function trendValuesForDate(type, date) {
    if (type === 'usage') {
      const usage = computeDailyUsage(date);
      const count = equipmentLogs(DB.dailyLogs).filter(item => item.date === date).length;
      return { value: usage.hours, secondary: usage.km, count };
    }
    const records = equipmentLogs(type === 'work' ? DB.workLogs : type === 'fuel' ? DB.fuelLogs : DB.maintLogs).filter(item => item.date === date);
    if (type === 'work') return { value: records.reduce((total, item) => total + numberOr(item.hours), 0), secondary: 0, count: records.length };
    if (type === 'fuel') return { value: records.reduce((total, item) => total + numberOr(item.liters), 0), secondary: 0, count: records.length };
    return { value: records.reduce((total, item) => total + numberOr(item.cost), 0), secondary: 0, count: records.length };
  }

  function formatTrendValue(value, unit) {
    return unit === '원' ? `${formatNumber(Math.round(value))}원` : `${formatNumber(value, 1)}${unit}`;
  }

  function formatUsageTrendCell(hours, km) {
    return `${formatNumber(hours, 1)}h\n${formatNumber(km, 1)}km`;
  }

  function renderTrendSummary(entries, metadata) {
    const summary = $('trend-summary');
    if (usageTrendType !== 'usage' && usageTrendType !== 'work') {
      summary.classList.add('hidden');
      summary.replaceChildren();
      return;
    }
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const average = total / entries.length;
    const periodLabel = usageTrendRange === 'month' ? `${entries.length}일 기준` : '7일 기준';
    const createItem = (label, value) => {
      const item = document.createElement('div'); item.className = 'trend-summary-item';
      const title = document.createElement('span'); title.textContent = label;
      const amount = document.createElement('strong'); amount.textContent = value;
      item.append(title, amount); return item;
    };
    if (usageTrendType === 'usage') {
      const totalKm = entries.reduce((sum, entry) => sum + numberOr(entry.secondary), 0);
      const avgKm = totalKm / entries.length;
      summary.replaceChildren(
        createItem('운행시간 합계', formatTrendValue(total, 'h')),
        createItem('주행거리 합계', formatTrendValue(totalKm, 'km')),
        createItem(`시간 일평균 (${periodLabel})`, formatTrendValue(average, 'h')),
        createItem(`거리 일평균 (${periodLabel})`, formatTrendValue(avgKm, 'km'))
      );
    } else {
      summary.replaceChildren(
        createItem(`${metadata.metric} 합계`, formatTrendValue(total, metadata.unit)),
        createItem(`일평균 (${periodLabel})`, formatTrendValue(average, metadata.unit))
      );
    }
    summary.classList.remove('hidden');
  }

  function renderUsageTrend() {
    const isMonthly = usageTrendRange === 'month';
    const metadata = trendMetadata[usageTrendType];
    const entries = trendDates().map(date => {
      const trend = trendValuesForDate(usageTrendType, date);
      return { date, label: isMonthly ? `${Number(date.slice(-2))}일` : date.slice(5).replace('-', '/'), ...trend };
    });
    if (isMonthly) {
      renderUsageCalendar(entries, metadata);
      return;
    }
    const values = entries.map(item => item.value);
    const maximum = Math.max(...values, 1);
    $('usage-trend-title').textContent = usageTrendType === 'usage' ? '최근 7일 운행시간·거리' : `최근 7일 ${metadata.metric}`;
    $('trend-type').value = usageTrendType;
    renderTrendSummary(entries, metadata);
    $('usage-trend').classList.remove('monthly');
    $('usage-trend').parentElement.classList.remove('monthly');
    $('trend-range-week').classList.toggle('active', !isMonthly);
    $('trend-range-month').classList.toggle('active', isMonthly);
    $('usage-trend').replaceChildren(...entries.map((entry, index) => {
      const column = document.createElement('div');
      column.className = 'trend-col';
      const value = document.createElement('div');
      value.className = 'trend-value';
      if (usageTrendType === 'usage') {
        value.classList.add('trend-value-dual');
        value.innerHTML = `${formatNumber(entry.value, 1)}h<br><span class="trend-value-sub">${formatNumber(entry.secondary, 1)}km</span>`;
      } else {
        value.textContent = formatTrendValue(values[index], metadata.unit);
      }
      const wrap = document.createElement('div');
      wrap.className = 'trend-bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'trend-bar';
      bar.style.height = `${Math.max(2, values[index] / maximum * 100)}%`;
      wrap.append(bar);
      const label = document.createElement('div');
      label.className = 'trend-label';
      label.textContent = entry.label;
      column.append(value, wrap, label);
      return column;
    }));
  }

  function renderUsageCalendar(entries, metadata) {
    const container = $('usage-trend');
    const [year, month] = entries[0].date.split('-').map(Number);
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const today = localDateString();
    $('usage-trend-title').textContent = usageTrendType === 'usage' ? `${year}년 ${month}월 일자별 운행시간·거리` : `${year}년 ${month}월 일자별 ${metadata.metric}`;
    $('trend-type').value = usageTrendType;
    renderTrendSummary(entries, metadata);
    container.classList.add('monthly');
    container.parentElement.classList.add('monthly');
    $('trend-range-week').classList.remove('active');
    $('trend-range-month').classList.add('active');

    const weekdays = ['일', '월', '화', '수', '목', '금', '토'].map(label => {
      const item = document.createElement('div'); item.className = 'usage-calendar-weekday'; item.textContent = label; return item;
    });
    const blanks = Array.from({ length: firstWeekday }, () => {
      const item = document.createElement('div'); item.className = 'usage-calendar-day empty'; return item;
    });
    const days = entries.map((entry, index) => {
      const item = document.createElement('div');
      item.className = `usage-calendar-day${entry.count ? ' has-usage' : ''}${entry.date === today ? ' today' : ''}`;
      const day = document.createElement('span'); day.className = 'usage-calendar-date'; day.textContent = String(index + 1);
      const value = document.createElement('strong'); value.className = 'usage-calendar-hours';
      if (!entry.count) value.textContent = '-';
      else if (usageTrendType === 'usage') {
        value.classList.add('usage-calendar-dual');
        value.innerHTML = `${formatNumber(entry.value, 1)}h<br><span>${formatNumber(entry.secondary, 1)}km</span>`;
      } else value.textContent = formatTrendValue(entry.value, metadata.unit);
      item.append(day, value); return item;
    });
    container.replaceChildren(...weekdays, ...blanks, ...days);
  }

  function recordHasPhoto(item, type) {
    if (type === 'usage' || type === 'maint') return Boolean(item?.photo);
    if (type === 'fuel') return Boolean(item?.receipt);
    if (type === 'work') {
      const photos = Array.isArray(item?.photos) ? item.photos : (item?.photo ? [item.photo] : []);
      return photos.some(Boolean);
    }
    return null;
  }

  function historyRecords() {
    const month = $('history-month').value;
    const type = $('history-type').value;
    const records = [];
    const include = date => !month || date.startsWith(month);
    if (type === 'all' || type === 'off') equipmentLogs(DB.dayStatuses).filter(item => include(item.date)).forEach(item => {
      records.push({ type: 'off', id: item.id, date: item.date, createdAt: item.updatedAt || item.createdAt, icon: 'calendar', title: dayStatusLabel(item), detail: '계기값 입력 없이 운행 없음 처리', value: '완료', hasPhoto: null });
    });
    if (type === 'all' || type === 'usage') equipmentLogs(DB.dailyLogs).filter(item => include(item.date)).forEach(item => {
      const usage = computeDailyUsage(item.date);
      records.push({ type: 'usage', id: item.id, date: item.date, createdAt: item.createdAt || item.created_at, icon: 'gauge', title: '운행 기록', detail: item.memo, value: `${usage.hours.toFixed(1)}h · ${usage.km.toFixed(1)}km`, hasPhoto: recordHasPhoto(item, 'usage') });
    });
    if (type === 'all' || type === 'work') equipmentLogs(DB.workLogs).filter(item => include(item.date)).forEach(item => records.push({
      type: 'work', id: item.id, date: item.date, createdAt: item.createdAt || item.created_at, icon: 'clipboard', title: '작업 기록',
      detail: [item.company ? `작업 회사 ${item.company}` : '작업 회사 미입력', item.memo ? `메모 ${item.memo}` : ''].filter(Boolean).join(' · '),
      value: `${numberOr(item.hours).toFixed(1)}h`, hasPhoto: recordHasPhoto(item, 'work')
    }));
    if (type === 'all' || type === 'fuel') equipmentLogs(DB.fuelLogs).filter(item => include(item.date)).forEach(item => records.push({ type: 'fuel', id: item.id, date: item.date, createdAt: item.createdAt || item.created_at, icon: 'fuel', title: '주유 기록', detail: item.quick ? '상세 없이 체크' : item.memo, value: item.quick ? '완료' : `${numberOr(item.liters).toFixed(1)}L`, hasPhoto: recordHasPhoto(item, 'fuel') }));
    if (type === 'all' || type === 'maint') equipmentLogs(DB.maintLogs).filter(item => include(item.date)).forEach(item => records.push({ type: 'maint', id: item.id, date: item.date, createdAt: item.createdAt || item.created_at, icon: 'wrench', title: item.type || '정비 기록', detail: item.detail, value: `${formatNumber(item.cost)}원`, hasPhoto: recordHasPhoto(item, 'maint') }));
    return records.sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  function loadHistoryTab() {
    renderDriverMetrics();
    renderDriverRecordButtons();
    renderUsageTrend();
    const records = historyRecords();
    const container = $('history-list');
    if (!records.length) {
      renderEmpty(container, 'list', '조건에 맞는 기록이 없습니다.');
      return;
    }
    container.replaceChildren(...records.map(record => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      const icon = document.createElement('div');
      icon.className = 'history-icon';
      icon.append(svgIcon(record.icon));
      const content = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = `${record.date} · ${record.title}`;
      const meta = document.createElement('div');
      meta.className = 'history-meta';
      meta.textContent = record.detail || '메모 없음';
      content.append(title, meta);
      if (record.hasPhoto != null) {
        const photo = document.createElement('div');
        photo.className = `history-photo ${record.hasPhoto ? 'has' : 'none'}`;
        photo.textContent = record.hasPhoto ? '사진 있음' : '사진 없음';
        content.append(photo);
      }
      const right = document.createElement('div');
      const value = document.createElement('div');
      value.className = 'history-value';
      value.textContent = record.value;
      const remove = document.createElement('button');
      remove.className = 'icon-small danger-small';
      remove.type = 'button';
      remove.textContent = '삭제';
      remove.style.marginTop = '6px';
      remove.addEventListener('click', event => {
        event.stopPropagation();
        deleteHistoryRecord(record.type, record.id);
      });
      right.append(value, remove);
      item.append(icon, content, right);
      item.addEventListener('click', () => openHistoryRecord(record));
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openHistoryRecord(record);
        }
      });
      return item;
    }));
  }

  function setSelectedDate(date) {
    if (!isDateString(date) || !$('dateSelect')) return;
    $('dateSelect').value = date;
    updateDayBadge();
  }

  function openHistoryRecord(record) {
    if (!record?.type) return;
    setSelectedDate(record.date);
    editingWorkId = record.type === 'work' ? record.id : null;
    editingMaintId = record.type === 'maint' ? record.id : null;
    editingFuelId = record.type === 'fuel' ? record.id : null;
    const tab = { usage: 'usage', off: 'usage', work: 'work', fuel: 'fuel', maint: 'maint' }[record.type] || 'usage';
    switchTab(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function deleteHistoryRecord(type, id) {
    if (!confirm('이 기록을 삭제할까요? 삭제 후에는 백업 파일 없이 복구할 수 없습니다.')) return;
    const key = { off: 'dayStatuses', usage: 'dailyLogs', work: 'workLogs', fuel: 'fuelLogs', maint: 'maintLogs' }[type];
    if (!key) return;
    if (commit(next => { next[key] = next[key].filter(item => item.id !== id); })) {
      loadHistoryTab();
      showToast('기록을 삭제했습니다.');
    }
  }

  function dateDistance(fromDate, toDate) {
    const toUtc = value => {
      const [y, m, d] = value.split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    };
    return Math.round((toUtc(toDate) - toUtc(fromDate)) / 86400000);
  }

  function latestMaintenanceSchedule(equipmentId) {
    return logsForEquipment(DB.maintLogs, equipmentId)
      .filter(item => isDateString(item.nextDate))
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  }

  function equipmentAdminSnapshot(equipment, date) {
    const dayStatus = dayStatusForEquipment(date, equipment.id);
    const usageRecord = logsForEquipment(DB.dailyLogs, equipment.id).find(item => item.date === date);
    const workRecord = logsForEquipment(DB.workLogs, equipment.id).find(item => item.date === date);
    const fuels = logsForEquipment(DB.fuelLogs, equipment.id).filter(item => item.date === date);
    const maintenances = logsForEquipment(DB.maintLogs, equipment.id).filter(item => item.date === date);
    const usage = computeEquipmentUsage(date, equipment.id);
    const schedule = latestMaintenanceSchedule(equipment.id);
    const dueDays = schedule ? dateDistance(date, schedule.nextDate) : null;
    const isPastOrToday = date <= localDateString();
    const complete = Boolean(dayStatus || (usageRecord && workRecord));
    const partial = !dayStatus && Boolean(usageRecord || workRecord) && !complete;
    const missing = equipment.status === 'active' && isPastOrToday && !dayStatus && !usageRecord && !workRecord;
    let state = 'normal';
    let stateLabel = '기록 완료';
    if (equipment.status === 'idle') {
      state = 'idle'; stateLabel = '운휴';
    } else if (dayStatus) {
      state = 'idle'; stateLabel = dayStatusLabel(dayStatus);
    } else if (dueDays != null && dueDays < 0) {
      state = 'danger'; stateLabel = `점검 ${Math.abs(dueDays)}일 초과`;
    } else if (missing) {
      state = 'danger'; stateLabel = '기록 없음';
    } else if (dueDays != null && dueDays <= 7) {
      state = 'warning'; stateLabel = `점검 D-${Math.max(0, dueDays)}`;
    } else if (partial) {
      state = 'warning'; stateLabel = '부분 기록';
    } else if (!isPastOrToday) {
      state = 'idle'; stateLabel = '예정';
    }
    return {
      equipment, date, dayStatus, usageRecord, workRecord, fuels, maintenances, usage, schedule, dueDays,
      complete, partial, missing, state, stateLabel,
      workHours: numberOr(workRecord?.hours),
      fuelLiters: fuels.reduce((sum, item) => sum + numberOr(item.liters), 0),
      fuelAmount: fuels.reduce((sum, item) => sum + numberOr(item.amount), 0),
      maintenanceCost: maintenances.reduce((sum, item) => sum + numberOr(item.cost), 0)
    };
  }

  function adminSnapshots() {
    return DB.equipments.map(equipment => equipmentAdminSnapshot(equipment, selectedDate()));
  }

  function renderAdminHistoryEquipmentFilter() {
    const select = $('admin-history-equipment');
    const previous = select.value || 'all';
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = '전체 장비';
    select.append(all);
    DB.equipments.forEach(equipment => {
      const option = document.createElement('option');
      option.value = equipment.id;
      option.textContent = equipment.name;
      select.append(option);
    });
    select.value = DB.equipments.some(item => item.id === previous) ? previous : 'all';
  }

  function adminHistoryRecords() {
    const equipmentFilter = $('admin-history-equipment').value;
    const type = $('admin-history-type').value;
    const month = $('admin-history-month').value;
    const equipmentMap = new Map(DB.equipments.map(item => [item.id, item]));
    const allowed = item => (equipmentFilter === 'all' || item.equipmentId === equipmentFilter) && (!month || item.date.startsWith(month));
    const records = [];
    if (type === 'all' || type === 'off') DB.dayStatuses.filter(allowed).forEach(item => {
      const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return;
      records.push({ type: 'off', date: item.date, equipment, icon: 'calendar', title: dayStatusLabel(item), detail: '계기값 입력 없이 운행 없음 처리', value: '완료', createdAt: item.updatedAt || item.createdAt });
    });
    if (type === 'all' || type === 'usage') DB.dailyLogs.filter(allowed).forEach(item => {
      const equipment = equipmentMap.get(item.equipmentId);
      if (!equipment) return;
      const usage = computeEquipmentUsage(item.date, item.equipmentId);
      records.push({ type: 'usage', date: item.date, equipment, icon: 'gauge', title: '운행', detail: item.memo || '메모 없음', value: `${usage.hours.toFixed(1)}h · ${usage.km.toFixed(1)}km`, createdAt: item.createdAt || item.created_at });
    });
    if (type === 'all' || type === 'work') DB.workLogs.filter(allowed).forEach(item => {
      const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return;
      records.push({ type: 'work', date: item.date, equipment, icon: 'clipboard', title: '작업', detail: item.company || '작업 회사 미입력', value: `${numberOr(item.hours).toFixed(1)}h`, createdAt: item.createdAt || item.created_at });
    });
    if (type === 'all' || type === 'fuel') DB.fuelLogs.filter(allowed).forEach(item => {
      const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return;
      records.push({ type: 'fuel', date: item.date, equipment, icon: 'fuel', title: '주유', detail: item.quick ? '상세 없이 체크' : item.memo || '메모 없음', value: item.quick ? '완료' : `${numberOr(item.liters).toFixed(1)}L`, createdAt: item.createdAt || item.created_at });
    });
    if (type === 'all' || type === 'maint') DB.maintLogs.filter(allowed).forEach(item => {
      const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return;
      records.push({ type: 'maint', date: item.date, equipment, icon: 'wrench', title: item.type || '정비', detail: item.detail || '상세 없음', value: `${formatNumber(item.cost)}원`, createdAt: item.createdAt || item.created_at });
    });
    return records.sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 100);
  }

  function renderAdminHistory() {
    const container = $('admin-history-list');
    const records = adminHistoryRecords();
    if (!records.length) {
      renderEmpty(container, 'list', '조건에 맞는 전체 장비 기록이 없습니다.');
      return;
    }
    container.replaceChildren(...records.map(record => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const icon = document.createElement('div');
      icon.className = 'history-icon';
      icon.append(svgIcon(record.icon));
      const content = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = `${record.date} · ${record.equipment.name} · ${record.title}`;
      const meta = document.createElement('div');
      meta.className = 'history-meta';
      meta.textContent = record.detail;
      content.append(title, meta);
      const value = document.createElement('div');
      value.className = 'history-value';
      value.textContent = record.value;
      item.append(icon, content, value);
      return item;
    }));
  }

  function renderAdminAlerts(snapshots) {
    const alerts = [];
    snapshots.forEach(snapshot => {
      if (snapshot.equipment.status === 'idle') return;
      if (snapshot.dueDays != null && snapshot.dueDays < 0) alerts.push({ level: 'danger', icon: 'alert', title: `${snapshot.equipment.name} 점검일 초과`, detail: `${snapshot.schedule.nextDate} 기준 ${Math.abs(snapshot.dueDays)}일 지났습니다.` });
      else if (snapshot.dueDays != null && snapshot.dueDays <= 7) alerts.push({ level: '', icon: 'wrench', title: `${snapshot.equipment.name} 점검 임박`, detail: `${snapshot.schedule.nextDate} · ${snapshot.dueDays === 0 ? '오늘 점검' : `${snapshot.dueDays}일 남음`}` });
      if (snapshot.missing) alerts.push({ level: 'danger', icon: 'clipboard', title: `${snapshot.equipment.name} 기록 없음`, detail: `${snapshot.date} 사용 또는 작업 기록을 확인해주세요.` });
      else if (snapshot.partial) alerts.push({ level: 'info', icon: 'alert', title: `${snapshot.equipment.name} 부분 기록`, detail: snapshot.usageRecord ? '작업시간 기록이 없습니다.' : '계기판 사용 기록이 없습니다.' });
    });
    const container = $('admin-alert-list');
    if (!alerts.length) {
      const item = document.createElement('div');
      item.className = 'admin-alert info';
      const icon = document.createElement('span'); icon.append(svgIcon('check'));
      const text = document.createElement('div');
      const title = document.createElement('div'); title.className = 'admin-alert-title'; title.textContent = '확인할 항목이 없습니다.';
      const detail = document.createElement('div'); detail.className = 'admin-alert-detail'; detail.textContent = '모든 운행 장비의 기록과 점검 일정을 확인했습니다.';
      text.append(title, detail); item.append(icon, text); container.replaceChildren(item); return;
    }
    container.replaceChildren(...alerts.map(alert => {
      const item = document.createElement('div'); item.className = `admin-alert ${alert.level}`.trim();
      const icon = document.createElement('span'); icon.append(svgIcon(alert.icon));
      const text = document.createElement('div');
      const title = document.createElement('div'); title.className = 'admin-alert-title'; title.textContent = alert.title;
      const detail = document.createElement('div'); detail.className = 'admin-alert-detail'; detail.textContent = alert.detail;
      text.append(title, detail); item.append(icon, text); return item;
    }));
  }

  function openEquipmentFromAdmin(equipmentId) {
    selectEquipment(equipmentId);
    switchMode('record');
    switchTab('summary');
  }

  function renderAdminEquipmentCards(snapshots) {
    const container = $('admin-equipment-list');
    container.replaceChildren(...snapshots.map(snapshot => {
      const card = document.createElement('div'); card.className = 'admin-equipment-card';
      const head = document.createElement('div'); head.className = 'admin-equipment-head';
      const info = document.createElement('div');
      const name = document.createElement('div'); name.className = 'admin-equipment-name'; name.textContent = snapshot.equipment.name;
      const meta = document.createElement('div'); meta.className = 'admin-equipment-meta'; meta.textContent = [snapshot.equipment.category, snapshot.equipment.type, snapshot.equipment.number].filter(Boolean).join(' · ') || '상세 정보 없음';
      info.append(name, meta);
      const badge = document.createElement('span'); badge.className = `status-badge status-${snapshot.state}`; badge.textContent = snapshot.stateLabel;
      head.append(info, badge);
      const metrics = document.createElement('div'); metrics.className = 'admin-equipment-metrics';
      const values = [
        ['작업', `${snapshot.workHours.toFixed(1)}h`],
        ['주유', `${snapshot.fuelLiters.toFixed(1)}L`],
        ['현재 계기', snapshot.usage.hourMeter == null ? '-' : `${formatNumber(snapshot.usage.hourMeter)}h`]
      ];
      values.forEach(([label, value]) => {
        const metric = document.createElement('div'); metric.className = 'admin-equipment-metric';
        const labelElement = document.createElement('span'); labelElement.textContent = label;
        const valueElement = document.createElement('strong'); valueElement.textContent = value;
        metric.append(labelElement, valueElement); metrics.append(metric);
      });
      const button = document.createElement('button'); button.className = 'btn btn-primary btn-small'; button.style.width = '100%'; button.textContent = '장비 기록 보기';
      button.addEventListener('click', () => openEquipmentFromAdmin(snapshot.equipment.id));
      card.append(head, metrics, button); return card;
    }));
  }

  function loadAdminDashboard() {
    setBrandTitle('통합관리');
    document.title = '통합관리 | 장비온';
    const snapshots = adminSnapshots();
    const active = snapshots.filter(item => item.equipment.status === 'active');
    const complete = active.filter(item => item.complete);
    const incomplete = active.filter(item => item.missing || item.partial);
    const due = active.filter(item => item.dueDays != null && item.dueDays <= 7);
    $('admin-date-label').textContent = `${selectedDate()} 기준 전체 장비 현황`;
    $('admin-total-equipment').textContent = String(snapshots.length);
    $('admin-active-equipment').textContent = `운행 ${active.length}대 · 운휴 ${snapshots.length - active.length}대`;
    $('admin-complete-equipment').textContent = String(complete.length);
    $('admin-missing-equipment').textContent = String(incomplete.length);
    $('admin-due-equipment').textContent = String(due.length);
    $('admin-total-work').textContent = `${active.reduce((sum, item) => sum + item.workHours, 0).toFixed(1)}h`;
    $('admin-total-fuel').textContent = `${active.reduce((sum, item) => sum + item.fuelLiters, 0).toFixed(1)}L`;
    $('admin-total-maint-cost').textContent = `${formatNumber(active.reduce((sum, item) => sum + item.maintenanceCost, 0))}원`;
    renderAdminAlerts(snapshots);
    renderAdminEquipmentCards(snapshots);
    renderAdminHistoryEquipmentFilter();
    renderAdminHistory();
  }

  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function exportAdminCsv() {
    const equipmentMap = new Map(DB.equipments.map(item => [item.id, item]));
    const rows = [['날짜', '장비명', '분류', '규격', '기록종류', '사용시간', '주행거리', '작업시간', '주유량', '단가', '금액', '정비종류', '상세', '정비비', '다음점검일']];
    DB.dailyLogs.forEach(item => { const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return; const usage = computeEquipmentUsage(item.date, item.equipmentId); rows.push([item.date, equipment.name, equipment.category, equipment.type, '사용', usage.hours, usage.km, '', '', '', '', '', item.memo || '', '', '']); });
    DB.workLogs.forEach(item => { const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return; rows.push([item.date, equipment.name, equipment.category, equipment.type, '작업', '', '', numberOr(item.hours), '', '', '', '', item.memo || '', '', '']); });
    DB.fuelLogs.forEach(item => { const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return; rows.push([item.date, equipment.name, equipment.category, equipment.type, '주유', '', '', '', numberOr(item.liters), numberOr(item.unitPrice), numberOr(item.amount), '', item.quick ? '상세 없이 체크' : item.memo || '', '', '']); });
    DB.maintLogs.forEach(item => { const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return; rows.push([item.date, equipment.name, equipment.category, equipment.type, '정비', '', '', '', '', '', '', item.type || '', item.detail || '', numberOr(item.cost), item.nextDate || '']); });
    DB.dayStatuses.forEach(item => { const equipment = equipmentMap.get(item.equipmentId); if (!equipment) return; rows.push([item.date, equipment.name, equipment.category, equipment.type, dayStatusLabel(item), 0, 0, 0, '', '', '', '', '계기값 입력 없이 운행 없음 처리', '', '']); });
    rows.splice(1, rows.length - 1, ...rows.slice(1).sort((a, b) => String(b[0]).localeCompare(String(a[0]))));
    const blob = new Blob([`\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `장비온_통합관리_${localDateString()}.csv`;
    document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    showToast('전체 장비 CSV를 저장했습니다.');
  }

  function renderEquipmentList() {
    const container = $('equipment-list');
    container.replaceChildren(...DB.equipments.map(equipment => {
      const row = document.createElement('div');
      row.className = `equipment-row${equipment.id === DB.currentEquipmentId ? ' active' : ''}`;
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'equipment-row-title';
      title.textContent = equipment.name;
      const meta = document.createElement('div');
      meta.className = 'equipment-row-meta';
      meta.textContent = [equipment.category, equipment.type, equipment.number, equipment.status === 'idle' ? '운휴' : ''].filter(Boolean).join(' · ') || '상세 정보 없음';
      info.append(title, meta);
      info.addEventListener('click', () => selectEquipment(equipment.id));
      info.style.cursor = 'pointer';
      const actions = document.createElement('div');
      actions.className = 'equipment-row-actions';
      const edit = document.createElement('button');
      edit.className = 'icon-small';
      edit.type = 'button';
      edit.textContent = '수정';
      edit.addEventListener('click', () => editEquipment(equipment.id));
      const remove = document.createElement('button');
      remove.className = 'icon-small danger-small';
      remove.type = 'button';
      remove.textContent = '삭제';
      remove.addEventListener('click', () => deleteEquipment(equipment.id));
      actions.append(edit, remove);
      row.append(info, actions);
      return row;
    }));
  }


  const EQUIPMENT_DOC_TYPES = [
    { id: 'biz_reg', label: '사업자등록증' },
    { id: 'machine_reg_front', label: '건설기계등록증 (앞)' },
    { id: 'machine_reg_back', label: '건설기계등록증 (뒤)' },
    { id: 'insurance', label: '보험증권' },
    { id: 'operator_license', label: '건설기계조종사면허증' },
    { id: 'basic_safety_cert', label: '건설업 기초안전보건교육 이수증' },
    { id: 'operator_safety_cert', label: '건설기계조종사 안전교육 이수증' },
    { id: 'special_worker_edu', label: '특수형태근로종사자 교육실시확인서' },
    { id: 'biz_account', label: '사업자계좌번호' },
    { id: 'manage_contract', label: '건설기계관리계약서' },
    { id: 'machine_spec', label: '건설기계재원표' },
    { id: 'other', label: '기타' }
  ];

  let pendingEquipmentDocType = null;
  const selectedEquipmentDocTypes = new Set();
  const SPONSOR_BANNER_KEY = 'jangbion_sponsor_banner_hidden_v1';

  function equipmentDocsForCurrent() {
    return (DB.equipmentDocs || []).filter(item => item.equipmentId === DB.currentEquipmentId);
  }

  function findEquipmentDoc(docType) {
    return equipmentDocsForCurrent().find(item => item.docType === docType) || null;
  }

  function renderEquipmentDocs() {
    const list = $('equipment-docs-list');
    if (!list) return;
    list.replaceChildren(...EQUIPMENT_DOC_TYPES.map(def => {
      const existing = findEquipmentDoc(def.id);
      const row = document.createElement('div');
      row.className = 'doc-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'doc-check';
      check.disabled = !existing?.photo;
      check.checked = selectedEquipmentDocTypes.has(def.id) && Boolean(existing?.photo);
      check.addEventListener('change', () => {
        if (check.checked) selectedEquipmentDocTypes.add(def.id);
        else selectedEquipmentDocTypes.delete(def.id);
      });
      let thumb;
      if (existing?.photo) {
        thumb = document.createElement('img');
        thumb.className = 'doc-thumb';
        thumb.src = existing.photo;
        thumb.alt = def.label;
      } else {
        thumb = document.createElement('div');
        thumb.className = 'doc-thumb placeholder';
        thumb.textContent = '없음';
      }
      const meta = document.createElement('div');
      meta.className = 'doc-meta';
      const name = document.createElement('div');
      name.className = 'doc-name';
      name.textContent = def.label;
      const status = document.createElement('div');
      status.className = 'doc-status';
      status.textContent = existing?.photo
        ? `등록됨 · ${(existing.updatedAt || '').slice(0, 10)}`
        : '미등록';
      meta.append(name, status);
      const actions = document.createElement('div');
      actions.className = 'doc-actions';
      const attach = document.createElement('button');
      attach.type = 'button';
      attach.textContent = existing?.photo ? '교체' : '첨부';
      attach.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        pendingEquipmentDocType = def.id;
        openPhotoSourcePicker('inp-equipment-doc');
      });
      actions.append(attach);
      if (existing?.photo) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '삭제';
        remove.addEventListener('click', () => removeEquipmentDoc(def.id));
        actions.append(remove);
      }
      row.append(check, thumb, meta, actions);
      return row;
    }));
  }

  function removeEquipmentDoc(docType) {
    if (!confirm('이 서류를 삭제할까요?')) return;
    if (commit(next => {
      next.equipmentDocs = (next.equipmentDocs || []).filter(
        item => !(item.equipmentId === DB.currentEquipmentId && item.docType === docType)
      );
    })) {
      selectedEquipmentDocTypes.delete(docType);
      renderEquipmentDocs();
      showToast('서류를 삭제했습니다.');
    }
  }

  async function saveEquipmentDocFromFile(file) {
    if (!pendingEquipmentDocType || !file) return;
    const docType = pendingEquipmentDocType;
    pendingEquipmentDocType = null;
    try {
      const photo = await compressImage(file);
      const def = EQUIPMENT_DOC_TYPES.find(item => item.id === docType);
      const existing = findEquipmentDoc(docType);
      const record = {
        id: existing?.id || uid('edoc'),
        equipmentId: DB.currentEquipmentId,
        docType,
        label: def?.label || docType,
        photo,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (commit(next => {
        next.equipmentDocs = next.equipmentDocs || [];
        const idx = next.equipmentDocs.findIndex(
          item => item.equipmentId === record.equipmentId && item.docType === docType
        );
        if (idx >= 0) next.equipmentDocs[idx] = record;
        else next.equipmentDocs.push(record);
      })) {
        renderEquipmentDocs();
        showToast(`${record.label}을(를) 저장했습니다.`);
      }
    } catch (error) {
      showToast(error.message || '서류 이미지를 저장하지 못했습니다.');
    }
  }

  async function shareSelectedEquipmentDocs() {
    const types = [...selectedEquipmentDocTypes];
    if (!types.length) {
      showToast('공유할 서류를 선택해주세요.');
      return;
    }
    const docs = types.map(findEquipmentDoc).filter(item => item?.photo);
    if (!docs.length) {
      showToast('선택한 서류에 이미지가 없습니다.');
      return;
    }
    try {
      const files = [];
      for (const doc of docs) {
        const blob = await blobFromDisplayValue(doc.photo);
        if (!blob) continue;
        const safe = (doc.label || doc.docType || 'doc').replace(/[\\/:*?"<>|]/g, '_');
        files.push(new File([blob], `${safe}.jpg`, { type: blob.type || 'image/jpeg' }));
      }
      if (!files.length) {
        showToast('공유할 파일을 만들지 못했습니다.');
        return;
      }
      if (navigator.share && navigator.canShare?.({ files })) {
        await navigator.share({
          title: '장비온 구비 서류',
          text: '현장 구비 서류입니다.',
          files
        });
        showToast('공유 화면을 열었습니다. 문자·카톡 등을 선택하세요.');
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: '장비온 구비 서류', text: `구비 서류 ${files.length}건. 이미지 첨부는 기기에서 지원할 때 가능합니다.` });
        showToast('텍스트만 공유되었습니다. 이미지는 교체·미리보기 후 저장해 첨부하세요.');
        return;
      }
      // fallback: download first file
      const url = URL.createObjectURL(files[0]);
      const a = document.createElement('a');
      a.href = url;
      a.download = files[0].name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast('파일을 저장했습니다. 문자·카톡에서 첨부해 보내세요.');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      showToast('공유에 실패했습니다. 다시 시도해주세요.');
    }
  }

  function clearEquipmentDocSelection() {
    selectedEquipmentDocTypes.clear();
    renderEquipmentDocs();
  }

  function isSponsorBannerHidden() {
    try { return sessionStorage.getItem(SPONSOR_BANNER_KEY) === '1'; } catch (e) { return false; }
  }

  function renderSponsorBanner() {
    const banner = $('sponsor-banner');
    if (!banner) return;
    const hide = isSponsorBannerHidden();
    banner.classList.toggle('hidden', hide);
    document.body.classList.toggle('has-sponsor-banner', !hide);
  }

  function closeSponsorBanner() {
    try { sessionStorage.setItem(SPONSOR_BANNER_KEY, '1'); } catch (e) {}
    renderSponsorBanner();
  }

  function openEquipmentManager() {
    openSettings();
  }

  function openDataSettings(focus = 'storage') {
    updateStorageMeter();
    applyFontSize(getFontSize());
    updateAppVersionLabel();
    const panels = {
      version: 'data-panel-version',
      font: 'data-panel-font',
      storage: 'data-panel-storage',
      photos: 'data-panel-photos',
      backup: 'data-panel-backup',
      kakao: 'data-panel-kakao'
    };
    refreshSubmissionRoomUi();
    const keys = Object.keys(panels);
    const showAll = !focus || focus === 'all' || !panels[focus];
    keys.forEach(key => {
      const el = $(panels[key]);
      if (!el) return;
      el.classList.toggle('is-hidden', !showAll && key !== focus);
      el.style.outline = '';
    });
    $('data-settings-modal')?.classList.remove('hidden');
  }

  function closeDataSettings() {
    $('data-settings-modal')?.classList.add('hidden');
  }

  function getFontSize() {
    const value = localStorage.getItem(FONT_SIZE_KEY) || 'normal';
    return FONT_SIZE_OPTIONS.includes(value) ? value : 'normal';
  }

  function applyFontSize(size) {
    const next = FONT_SIZE_OPTIONS.includes(size) ? size : 'normal';
    document.documentElement.setAttribute('data-font-size', next);
    try { localStorage.setItem(FONT_SIZE_KEY, next); } catch (error) { console.warn(error); }
    document.querySelectorAll('input[name="font-size"]').forEach(input => {
      input.checked = input.value === next;
    });
  }

  function bindFontSizeControls() {
    document.querySelectorAll('input[name="font-size"]').forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) {
          applyFontSize(input.value);
          showToast('글자 크기를 적용했습니다.');
        }
      });
    });
  }

  function openSettings() {
    // 장비 탭: 목록·등록 + 구비 서류 + 정비 주기
    hideEquipmentForm();
    renderEquipmentList();
    updatePlanSummary();
    selectedEquipmentDocTypes.clear();
    renderEquipmentDocs();
    renderRecordServiceIntervalAlerts();
    $('settings-modal').classList.remove('hidden');
  }

  function closeSettings() {
    $('settings-modal').classList.add('hidden');
  }

  function hasRecordsForEquipment(equipmentId) {
    return ['dailyLogs', 'workLogs', 'fuelLogs', 'maintLogs', 'dayStatuses', 'submissions', 'operationSessions', 'inspections', 'faultReports'].some(key => DB[key].some(item => item.equipmentId === equipmentId));
  }

  function isUnusedStarterEquipment() {
    if (DB.equipments.length !== 1) return false;
    const equipment = DB.equipments[0];
    return equipment.name === '내 장비' && !equipment.type && !equipment.number && !hasRecordsForEquipment(equipment.id);
  }

  function showEquipmentForm(equipment = null, bypassPlanNotice = false) {
    if (!equipment && isUnusedStarterEquipment()) equipment = DB.equipments[0];
    if (!equipment && DB.equipments.length >= 1 && !bypassPlanNotice) {
      openFreePlanGuide('equipment');
      return;
    }
    $('equipment-edit-id').value = equipment?.id || '';
    $('equipment-name').value = equipment?.name || '';
    $('equipment-category').value = equipment?.category || '지게차';
    $('equipment-type').value = equipment?.type || '';
    $('equipment-number').value = equipment?.number || '';
    $('equipment-status').value = equipment?.status || 'active';
    $('equipment-form').classList.remove('hidden');
    $('equipment-name').focus();
  }

  function hideEquipmentForm() {
    $('equipment-form').classList.add('hidden');
    $('equipment-edit-id').value = '';
  }

  function saveEquipment() {
    const id = $('equipment-edit-id').value;
    const name = $('equipment-name').value.trim();
    if (!name) {
      showToast('장비 이름을 입력해주세요.');
      return;
    }
    const equipment = normalizeEquipment({
      id: id || uid('eq'), name, category: $('equipment-category').value,
      type: $('equipment-type').value.trim(), number: $('equipment-number').value.trim(),
      status: $('equipment-status').value,
      createdAt: DB.equipments.find(item => item.id === id)?.createdAt || new Date().toISOString()
    });
    if (commit(next => {
      const index = next.equipments.findIndex(item => item.id === equipment.id);
      if (index >= 0) next.equipments[index] = equipment; else next.equipments.push(equipment);
      next.currentEquipmentId = equipment.id;
    })) {
      hideEquipmentForm();
      renderEquipmentList();
      updatePlanSummary();
      updateEquipmentUI();
      if (currentMode === 'admin') loadAdminDashboard(); else refreshActiveTab();
      showToast(id ? '장비 정보를 수정했습니다.' : '새 장비를 등록했습니다.');
    }
  }

  function editEquipment(id) {
    const equipment = DB.equipments.find(item => item.id === id);
    if (equipment) showEquipmentForm(equipment);
  }

  function selectEquipment(id) {
    if (!DB.equipments.some(item => item.id === id)) return;
    if (commit(next => { next.currentEquipmentId = id; })) {
      currentUsagePhoto = null;
      currentWorkPhotos = [];
      updateEquipmentUI();
      renderEquipmentList();
      updatePlanSummary();
      if (currentMode === 'admin') loadAdminDashboard(); else refreshActiveTab();
      showToast('현재 장비를 변경했습니다.');
    }
  }

  function deleteEquipment(id) {
    if (DB.equipments.length <= 1) {
      showToast('장비는 최소 1대가 필요합니다.');
      return;
    }
    const equipment = DB.equipments.find(item => item.id === id);
    if (!equipment || !confirm(`‘${equipment.name}’과 연결된 모든 기록을 삭제할까요?`)) return;
    if (commit(next => {
      next.equipments = next.equipments.filter(item => item.id !== id);
      ['dailyLogs', 'workLogs', 'fuelLogs', 'maintLogs', 'dayStatuses', 'submissions', 'operationSessions', 'inspections', 'faultReports'].forEach(key => {
        next[key] = next[key].filter(item => item.equipmentId !== id);
      });
      if (next.currentEquipmentId === id) next.currentEquipmentId = next.equipments[0].id;
    })) {
      renderEquipmentList();
      updatePlanSummary();
      updateEquipmentUI();
      if (currentMode === 'admin') loadAdminDashboard(); else refreshActiveTab();
      showToast('장비와 연결 기록을 삭제했습니다.');
    }
  }

  function updateStorageMeter() {
    const textEl = $('storage-text');
    const bar = $('storage-bar');
    if (!textEl || !bar) return;
    estimateStorageBytes().then(({ bytes, usage, quota }) => {
      const limit = quota || APPROX_STORAGE_LIMIT;
      const percent = Math.min(100, (usage || bytes) / limit * 100);
      const photoHint = percent > 70 ? ' · 사진 정리를 권장합니다' : '';
      textEl.textContent = `예상 저장 ${formatNumber(bytes / 1024, 0)}KB · 약 ${percent.toFixed(1)}%${photoHint}`;
      bar.style.width = `${percent}%`;
      bar.style.background = percent > 80 ? 'var(--danger)' : percent > 60 ? 'var(--warning)' : 'var(--primary)';
      if (percent > 85) {
        const note = $('storage-action-hint');
        if (note) note.textContent = '저장 공간이 부족해질 수 있습니다. 아래 사진 정리를 사용하세요.';
      }
    }).catch(() => {
      const bytes = new Blob([JSON.stringify(DB)]).size;
      textEl.textContent = `예상 저장공간 ${formatNumber(bytes / 1024, 0)}KB`;
      bar.style.width = '0%';
    });
  }

  function purgePhotos30() { return purgePhotosOlderThan(30); }
  function purgePhotos90() { return purgePhotosOlderThan(getPhotoRetentionDays() || 90); }

  function updatePlanSummary() {
    const count = $('plan-equipment-count');
    const bar = $('plan-equipment-bar');
    if (!count || !bar) return;
    const total = DB.equipments.length;
    count.textContent = `${total}대 · 무료 안내 기준 1대`;
    bar.style.width = `${Math.min(100, total * 100)}%`;
    bar.style.background = total > 1 ? 'var(--warning)' : 'var(--primary)';
  }

  function openFreePlanGuide(source = 'details') {
    freePlanGuideSource = source;
    const isEquipmentAdd = source === 'equipment';
    const message = $('free-plan-message');
    const continueButton = $('plan-continue-equipment');
    const policyNote = $('plan-policy-note');
    if (message) {
      message.textContent = isEquipmentAdd
        ? '무료 플랜은 장비 1대를 기준으로 합니다. 두 번째 장비부터는 향후 확장 플랜 범위입니다.'
        : '장비 1대의 현장 기록을 간편하게 관리할 수 있습니다.';
    }
    continueButton?.classList.toggle('hidden', !isEquipmentAdd);
    if (policyNote) policyNote.classList.toggle('hidden', !isEquipmentAdd);
    $('free-plan-modal').classList.remove('hidden');
  }

  function closeFreePlanGuide() {
    $('free-plan-modal').classList.add('hidden');
    try { localStorage.setItem(PLAN_NOTICE_KEY, 'acknowledged'); } catch (error) { console.warn(error); }
    freePlanGuideSource = 'details';
  }

  function continueEquipmentRegistration() {
    if (freePlanGuideSource !== 'equipment') return;
    closeFreePlanGuide();
    showEquipmentForm(null, true);
  }

  async function exportBackup() {
    try {
      await queuePersist(DB, { pruneOrphans: true });
      const payload = clone(DB);
      // 화면에 쓰인 blob/object URL을 dataURL로 바꿔 호환 백업 생성
      const tasks = [];
      walkPhotoFields(payload, (owner, field, value, setValue) => {
        if (!value || typeof value !== 'string') return;
        if (value.startsWith('data:')) return;
        if (value.startsWith('blob:') || isPhotoRef(value)) {
          tasks.push((async () => {
            let blob = null;
            if (isPhotoRef(value)) {
              const row = await idbReq((await openIdb()).transaction('photos', 'readonly').objectStore('photos').get(photoIdFromRef(value)));
              blob = row?.blob || null;
            } else {
              blob = await blobFromDisplayValue(value);
            }
            if (!blob) { setValue(''); return; }
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            setValue(dataUrl);
          })());
        }
      });
      await Promise.all(tasks);
      payload.exportedAt = new Date().toISOString();
      payload.app = '장비온';
      payload.version = DB_VERSION;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `장비온_backup_${localDateString()}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      try { localStorage.setItem(BACKUP_REMINDER_KEY, new Date().toISOString()); } catch (error) { /* ignore */ }
      showToast('⬇ 백업 파일을 저장했습니다.');
    } catch (error) {
      console.error(error);
      showToast('백업 파일을 만들지 못했습니다.');
    }
  }

  function importBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      showToast('백업 파일이 너무 큽니다.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => showToast('백업 파일을 읽지 못했습니다.');
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!Array.isArray(parsed.dailyLogs) && !Array.isArray(parsed.equipments)) throw new Error('invalid');
        if (!confirm('현재 데이터를 백업 파일로 교체할까요? 기존 데이터는 덮어씁니다.')) return;
        const migrated = migrateDatabase(parsed);
        revokePhotoUrls();
        await persistDatabase(migrated, { pruneOrphans: true });
        await hydratePhotosInDb(migrated);
        DB = migrated;
        currentUsagePhoto = null;
        currentWorkPhotos = [];
        updateEquipmentUI();
        updatePlanSummary();
        closeSettings();
        closeDataSettings();
        refreshActiveTab();
        updateStorageMeter();
        showToast('⬆ 백업 데이터를 복원했습니다.');
      } catch (error) {
        console.error(error);
        showToast('올바른 장비온 백업 파일이 아닙니다.');
      }
    };
    reader.readAsText(file);
  }

  function isStandaloneMode() {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true || installCompleted;
  }

  function isAndroidKakaoBrowser() {
    const agent = navigator.userAgent || '';
    return /Android/i.test(agent) && /KAKAOTALK/i.test(agent);
  }

  function isInstallHandoffEntry() {
    const params = new URLSearchParams(location.search);
    return params.get(INSTALL_HANDOFF_PARAM) === '1';
  }

  function installTargetUrl() {
    const target = new URL(location.href);
    target.searchParams.set(INSTALL_HANDOFF_PARAM, '1');
    target.searchParams.set(INSTALL_HANDOFF_SOURCE_PARAM, 'kakao');
    target.hash = '';
    return target;
  }

  function chromeInstallIntentUrl() {
    const target = installTargetUrl();
    const scheme = target.protocol.replace(':', '');
    const intentPath = `${target.host}${target.pathname}${target.search}`;
    return `intent://${intentPath}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(target.toString())};end`;
  }

  function openInstallModalForHandoff() {
    updateInstallUI();
    $('install-modal')?.classList.remove('hidden');
  }

  function openInChromeForInstall() {
    if (!isAndroidKakaoBrowser()) {
      openInstallModalForHandoff();
      return;
    }
    const status = $('install-status');
    if (status) {
      status.className = 'install-status ready';
      status.textContent = 'Chrome으로 이동하고 있습니다. 이동 후 설치 버튼을 한 번 눌러주세요.';
    }
    location.href = chromeInstallIntentUrl();
    setTimeout(openInstallModalForHandoff, 900);
  }

  function handleInstallHandoff() {
    if (isStandaloneMode()) return;
    if (isAndroidKakaoBrowser()) {
      openInstallModalForHandoff();
      if (!sessionStorage.getItem(KAKAO_HANDOFF_GUARD)) {
        sessionStorage.setItem(KAKAO_HANDOFF_GUARD, String(Date.now()));
        openInChromeForInstall();
      }
      return;
    }
    if (isInstallHandoffEntry()) {
      openInstallModalForHandoff();
    }
  }

  function installPlatform() {
    const agent = navigator.userAgent || '';
    const isIos = /iPad|iPhone|iPod/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIos) return 'ios';
    if (isAndroidKakaoBrowser()) return 'kakao';
    if (/Android/i.test(agent)) return 'android';
    return 'desktop';
  }

  function updateInstallUI() {
    const status = $('install-status');
    const button = $('install-app-button');
    const headerButton = $('install-header-button');
    if (!status || !button || !headerButton) return;

    const platform = installPlatform();
    const installed = isStandaloneMode();
    ['kakao', 'android', 'ios', 'desktop'].forEach(name => {
      $(`install-guide-${name}`)?.classList.toggle('active', !installed && name === platform && !deferredInstallPrompt);
    });
    $('install-post-android')?.classList.toggle('active', installed && platform === 'android');

    status.className = 'install-status';
    button.classList.remove('install-app-button-ready');
    headerButton.classList.toggle('install-icon-ready', (Boolean(deferredInstallPrompt) || platform === 'kakao') && !installed);
    if (installed) {
      status.classList.add('installed');
      status.textContent = platform === 'android'
        ? '장비온 앱 설치가 완료되었습니다. 홈 화면에 보이지 않으면 아래 Galaxy 안내를 확인하세요.'
        : '장비온 앱 설치가 완료되었습니다.';
      button.textContent = '✓ 장비온 앱 설치 완료';
      button.disabled = true;
      return;
    }
    if (deferredInstallPrompt) {
      status.classList.add('ready');
      status.textContent = '설치 준비가 완료되었습니다. 아래 버튼을 한 번 누른 뒤 Chrome 확인창에서 설치를 승인하세요.';
      button.textContent = '장비온 앱 설치';
      button.disabled = false;
      button.classList.add('install-app-button-ready');
      return;
    }

    status.classList.add('manual');
    if (platform === 'kakao') {
      status.textContent = 'Chrome으로 자동 이동을 시도합니다. 이동되지 않으면 아래 버튼을 눌러주세요.';
      button.textContent = 'Chrome에서 열기';
      button.disabled = false;
    } else if (platform === 'ios') {
      button.disabled = true;
      status.textContent = 'iPhone은 Safari의 공유 메뉴에서 홈 화면에 추가할 수 있습니다.';
      button.textContent = '아래 iPhone 설치 방법을 따라주세요';
    } else if (platform === 'android') {
      button.disabled = true;
      status.textContent = isInstallHandoffEntry()
        ? 'Chrome에서 설치 준비 중입니다. 설치 버튼이 활성화될 때까지 잠시 기다려주세요.'
        : '설치 준비 중입니다. 설치 버튼이 활성화될 때까지 잠시 기다려주세요.';
      button.textContent = '설치 준비 중…';
    } else {
      button.disabled = true;
      status.textContent = '스마트폰의 Chrome 또는 Safari에서 이 주소를 열어 설치해주세요.';
      button.textContent = '스마트폰에서 설치할 수 있습니다';
    }
  }

  function openInstallGuide() {
    updateInstallUI();
    $('install-modal').classList.remove('hidden');
  }
  function closeInstallGuide() { $('install-modal').classList.add('hidden'); }

  async function installAppShortcut() {
    if (isStandaloneMode()) {
      showToast('✓ 이미 장비온 앱이 설치되어 있습니다.');
      updateInstallUI();
      return;
    }
    if (isAndroidKakaoBrowser()) {
      openInChromeForInstall();
      return;
    }
    if (!deferredInstallPrompt) {
      showToast('Chrome이 설치 준비 중입니다. 잠시 후 버튼이 활성화됩니다.');
      updateInstallUI();
      return;
    }

    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        showToast('장비온 앱 설치를 시작했습니다.');
      } else {
        showToast('설치를 취소했습니다. 언제든 다시 설치할 수 있습니다.');
      }
    } catch (error) {
      console.warn('앱 설치 창을 열지 못했습니다.', error);
      showToast('설치 창을 열지 못했습니다. 브라우저 메뉴에서 설치해주세요.');
    }
    updateInstallUI();
  }

  function bindInstallEvents() {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      deferredInstallPrompt = event;
      updateInstallUI();
      if (isInstallHandoffEntry()) openInstallModalForHandoff();
    });
    window.addEventListener('appinstalled', () => {
      installCompleted = true;
      deferredInstallPrompt = null;
      updateInstallUI();
      if (installPlatform() === 'android') {
        $('install-modal')?.classList.remove('hidden');
        showToast('장비온 앱 설치 완료. 홈 화면 표시 여부를 확인하세요.');
      } else {
        closeInstallGuide();
        showToast('장비온 앱 설치가 완료되었습니다.');
      }
    });
    window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', updateInstallUI);
  }
  function copySiteUrl() {
    const url = `${location.origin}/`;
    if (!navigator.clipboard?.writeText) {
      showToast(`주소: ${url}`);
      return;
    }
    navigator.clipboard.writeText(url).then(() => showToast('주소를 복사했습니다.')).catch(() => showToast(`주소: ${url}`));
  }

  let swRegistration = null;
  let swUpdateIntervalId = null;
  let applyingAppUpdate = false;

  function updateAppVersionLabel(extra = '') {
    const el = $('app-version-text');
    if (!el) return;
    const bits = [`v${APP_VERSION}`];
    if (isSecretMode()) bits.push('시크릿');
    if (extra) bits.push(extra);
    el.textContent = bits.join(' · ');
  }

  function showAppUpdateNotice() {
    $('app-update-banner')?.classList.add('show');
    updateAppVersionLabel('새 버전 준비됨');
  }

  function hideAppUpdateNotice() {
    $('app-update-banner')?.classList.remove('show');
  }

  function trackSwRegistration(registration) {
    swRegistration = registration;
    if (registration.waiting) showAppUpdateNotice();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          showAppUpdateNotice();
        }
      });
    });
  }

  function checkForAppUpdate(options = {}) {
    const { silent = true } = options;
    if (!('serviceWorker' in navigator)) {
      if (!silent) showToast('이 브라우저는 앱 업데이트를 지원하지 않습니다.');
      return Promise.resolve();
    }
    const run = registration => {
      if (!registration) {
        if (!silent) showToast('업데이트 정보를 확인할 수 없습니다.');
        return Promise.resolve();
      }
      return registration.update()
        .then(() => {
          if (registration.waiting) {
            showAppUpdateNotice();
            if (!silent) showToast('새 버전이 준비되었습니다. 적용을 눌러주세요.');
            return;
          }
          if (!silent) showToast('최신 버전입니다.');
          updateAppVersionLabel('최신');
        })
        .catch(() => {
          if (!silent) showToast('업데이트 확인에 실패했습니다. 네트워크를 확인해주세요.');
        });
    };
    if (swRegistration) return run(swRegistration);
    return navigator.serviceWorker.getRegistration().then(reg => {
      if (reg) trackSwRegistration(reg);
      return run(reg);
    }).catch(() => {
      if (!silent) showToast('업데이트 확인에 실패했습니다.');
    });
  }

  function applyAppUpdate() {
    if (applyingAppUpdate) return;
    applyingAppUpdate = true;
    const reloadNow = () => {
      hideAppUpdateNotice();
      window.location.reload();
    };
    const waiting = swRegistration?.waiting;
    if (waiting) {
      navigator.serviceWorker.addEventListener('controllerchange', () => reloadNow(), { once: true });
      waiting.postMessage({ type: 'SKIP_WAITING' });
      setTimeout(reloadNow, 1200);
      return;
    }
    checkForAppUpdate({ silent: true }).finally(() => {
      if (swRegistration?.waiting) {
        swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
        setTimeout(reloadNow, 800);
      } else {
        reloadNow();
      }
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      updateAppVersionLabel();
      return;
    }
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (applyingAppUpdate) {
        window.location.reload();
        return;
      }
      if (hadController) showAppUpdateNotice();
    });
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        trackSwRegistration(registration);
        registration.update().catch(() => {});
        if (swUpdateIntervalId) clearInterval(swUpdateIntervalId);
        swUpdateIntervalId = setInterval(() => checkForAppUpdate({ silent: true }), SW_UPDATE_INTERVAL_MS);
      })
      .catch(error => console.warn('서비스워커 등록 실패', error));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForAppUpdate({ silent: true });
    });
    window.addEventListener('online', () => checkForAppUpdate({ silent: true }));
    updateAppVersionLabel();
  }

  function bindEvents() {
    const resetLegacyControl = id => {
      const original = $(id);
      const replacement = original.cloneNode(true);
      original.replaceWith(replacement);
      return replacement;
    };
    resetLegacyControl('btn-work-photo-pick');
    resetLegacyControl('inp-work-photo');
    resetLegacyControl('btn-save-work');
    $('btn-work-field-settings').addEventListener('click', () => $('work-field-settings').classList.toggle('hidden'));
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    $('equipment-select').addEventListener('change', event => selectEquipment(event.target.value));
    $('dateSelect').addEventListener('change', () => {
      updateDayBadge();
      if (currentMode === 'admin') loadAdminDashboard(); else refreshActiveTab();
    });
    $('inp-hm').addEventListener('input', () => handleUsageFieldInput('hourMeter'));
    $('inp-odo').addEventListener('input', () => handleUsageFieldInput('odometer'));
    $('btn-save-usage').addEventListener('click', saveUsage);
    $('btn-day-holiday').addEventListener('click', () => markDayStatus('holiday'));
    $('btn-day-no-operation').addEventListener('click', () => markDayStatus('no-operation'));
    $('btn-clear-day-status').addEventListener('click', clearSelectedDayStatus);
    $('btn-usage-photo-pick').addEventListener('click', () => openPhotoSourcePicker('inp-usage-photo'));
    $('inp-usage-photo').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const source = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('사진을 불러오지 못했습니다.'));
          reader.readAsDataURL(file);
        });
        if (isSecretMode()) openUsageCropper(source);
        else await applyUsagePhoto(await compressImageDataUrl(source), { analyze: false });
      } catch (error) { showToast(error.message); }
    });
    $('btn-usage-photo-remove').addEventListener('click', () => {
      currentUsagePhoto = null;
      currentUsageAnalysis = null;
      resetUsageAiFields();
      showPhotoPreview('usage-photo-preview', 'usage-photo-img', null);
      setUsageAiPanel();
    });
    $('usage-crop-stage').addEventListener('pointerdown', event => {
      usageCropStart = usageCropPoint(event);
      $('usage-crop-stage').setPointerCapture?.(event.pointerId);
    });
    $('usage-crop-stage').addEventListener('pointermove', event => {
      if (!usageCropStart) return;
      const point = usageCropPoint(event);
      usageCropRect = { x: Math.min(usageCropStart.x, point.x), y: Math.min(usageCropStart.y, point.y), width: Math.abs(point.x - usageCropStart.x), height: Math.abs(point.y - usageCropStart.y) };
      renderUsageCropSelection();
    });
    $('usage-crop-stage').addEventListener('pointerup', () => { usageCropStart = null; });
    $('btn-usage-crop-apply').addEventListener('click', async () => {
      if (usageCropRect.width < 0.08 || usageCropRect.height < 0.08) return showToast('자를 영역을 조금 더 크게 선택해주세요.');
      try {
        const cropped = await cropUsagePhoto();
        closeUsageCropper();
        await applyUsagePhoto(cropped);
      } catch (error) { showToast(error.message); }
    });
    $('btn-usage-crop-reset').addEventListener('click', () => {
      usageCropRect = { x: 0, y: 0, width: 1, height: 1 };
      renderUsageCropSelection();
    });
    $('btn-usage-crop-reselect').addEventListener('click', () => {
      closeUsageCropper();
      openPhotoSourcePicker('inp-usage-photo');
    });
    $('btn-usage-crop-cancel').addEventListener('click', async () => {
      const source = pendingUsagePhoto;
      closeUsageCropper();
      if (!source) return;
      try {
        const original = await compressImageDataUrl(source);
        await applyUsagePhoto(original, { analyze: false });
      } catch (error) { showToast(error.message); }
    });
    window.addEventListener('resize', () => {
      if (!$('usage-crop-modal')?.classList.contains('hidden')) renderUsageCropSelection();
    });
    $('btn-work-photo-pick').addEventListener('click', () => openPhotoSourcePicker('inp-work-photo'));
    $('inp-work-photo').addEventListener('change', async event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      const room = MAX_WORK_PHOTOS - currentWorkPhotos.length;
      if (room <= 0) return showToast(`작업 사진은 최대 ${MAX_WORK_PHOTOS}장입니다.`);
      for (const file of files.slice(0, room)) {
        try { currentWorkPhotos.push(await compressImage(file)); }
        catch (error) { showToast(error.message); }
      }
      renderWorkPhotoGrid();
    });
    $('btn-save-work').addEventListener('click', saveWork);
    $('btn-new-work').addEventListener('click', startNewWorkRecord);
    $('btn-new-maint')?.addEventListener('click', startNewMaintRecord);
    $('btn-share-equipment-docs')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); shareSelectedEquipmentDocs(); });
    $('btn-clear-doc-selection')?.addEventListener('click', clearEquipmentDocSelection);
    $('inp-equipment-doc')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) await saveEquipmentDocFromFile(file);
    });
    $('sponsor-banner-close')?.addEventListener('click', closeSponsorBanner);
    $('sponsor-banner-action')?.addEventListener('click', () => { openEquipmentManager(); });

    ['chk-fuel-quick', 'chk-fuel-quick-summary'].map($).filter(Boolean).forEach(input => input.addEventListener('change', event => toggleFuelQuick(event.target.checked)));
    $('inp-liters').addEventListener('input', updateFuelPreview);
    $('inp-unit-price').addEventListener('input', updateFuelPreview);
    $('btn-save-fuel').addEventListener('click', saveFuel);
    const bindSinglePhoto = (inputId, pickId, removeId, previewId, imageId, setValue) => {
      $(pickId).addEventListener('click', () => openPhotoSourcePicker(inputId));
      $(inputId).addEventListener('change', async event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) return;
        try { const data = await compressImage(file); setValue(data); showPhotoPreview(previewId, imageId, data); }
        catch (error) { showToast(error.message); }
      });
      $(removeId).addEventListener('click', () => { setValue(null); showPhotoPreview(previewId, imageId, null); });
    };
    bindSinglePhoto('inp-fuel-receipt', 'btn-fuel-receipt-pick', 'btn-fuel-receipt-remove', 'fuel-receipt-preview', 'fuel-receipt-img', value => { currentFuelReceipt = value; });
    bindSinglePhoto('inp-inspection-photo', 'btn-inspection-photo-pick', 'btn-inspection-photo-remove', 'inspection-photo-preview', 'inspection-photo-img', value => { currentInspectionPhoto = value; });
    bindSinglePhoto('inp-fault-photo', 'btn-fault-photo-pick', 'btn-fault-photo-remove', 'fault-photo-preview', 'fault-photo-img', value => { currentFaultPhoto = value; });
    bindSinglePhoto('inp-maint-photo', 'btn-maint-photo-pick', 'btn-maint-photo-remove', 'maint-photo-preview', 'maint-photo-img', value => { currentMaintenancePhoto = value; });
    $('btn-save-maint').addEventListener('click', saveMaintenance);
    $('trend-range-week').addEventListener('click', () => { usageTrendRange = 'week'; renderUsageTrend(); });
    $('trend-range-month').addEventListener('click', () => { usageTrendRange = 'month'; renderUsageTrend(); });
    $('trend-type').addEventListener('change', event => { usageTrendType = event.target.value; renderUsageTrend(); });
    $('btn-apply-update')?.addEventListener('click', applyAppUpdate);
    $('btn-check-update')?.addEventListener('click', () => checkForAppUpdate({ silent: false }));
    let secretTapCount = 0;
    let secretTapTimer = 0;
    $('app-version-row')?.addEventListener('click', event => {
      if (event.target.closest('#btn-check-update')) return;
      clearTimeout(secretTapTimer);
      secretTapCount += 1;
      if (secretTapCount >= 7) {
        secretTapCount = 0;
        setSecretMode(!isSecretMode());
        return;
      }
      secretTapTimer = window.setTimeout(() => { secretTapCount = 0; }, 1800);
    });
    $('btn-toggle-equipment-docs')?.addEventListener('click', () => {
      const body = $('equipment-docs-body');
      const caret = $('equipment-docs-caret');
      const button = $('btn-toggle-equipment-docs');
      if (!body || !button) return;
      const open = body.classList.contains('hidden');
      body.classList.toggle('hidden', !open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (caret) caret.textContent = open ? '접기' : '펼치기';
    });
    $('history-type').addEventListener('change', loadHistoryTab);
    $('history-month').addEventListener('change', loadHistoryTab);
    $('admin-history-equipment').addEventListener('change', renderAdminHistory);
    $('admin-history-type').addEventListener('change', renderAdminHistory);
    $('admin-history-month').addEventListener('change', renderAdminHistory);
    window.addEventListener('online', () => { updateOnlineStatus(); if (currentMode === 'record') loadSummary(); });
    window.addEventListener('offline', () => { updateOnlineStatus(); if (currentMode === 'record') loadSummary(); });
    document.querySelectorAll('.modal-overlay').forEach(modal => modal.addEventListener('click', event => {
      if (event.target === modal) modal.classList.add('hidden');
    }));
  }

  function initialize() {
    applyFontSize(getFontSize());
    consumeSecretQuery();
    applySecretModeUi();
    bindFontSizeControls();
    $('dateSelect').value = localDateString();
    $('history-month').value = localDateString().slice(0, 7);
    $('admin-history-month').value = localDateString().slice(0, 7);
    updateDayBadge();
    updateOnlineStatus();
    updateEquipmentUI();
    applyWorkFieldLayout();
    bindInstallEvents();
    updateInstallUI();
    bindEvents();
    loadSummary();
    updatePlanSummary();
    updateStorageMeter();
    handleInstallHandoff();
    if (!localStorage.getItem(PLAN_NOTICE_KEY) && !isInstallHandoffEntry() && !isAndroidKakaoBrowser()) {
      setTimeout(() => openFreePlanGuide('welcome'), 350);
    }
    registerServiceWorker();
    const lastBackup = localStorage.getItem(BACKUP_REMINDER_KEY);
    if (lastBackup) {
      const elapsed = Date.now() - Date.parse(lastBackup);
      if (Number.isFinite(elapsed) && elapsed > 7 * 24 * 60 * 60 * 1000) {
        setTimeout(() => showToast('백업한 지 7일이 지났습니다. 설정에서 백업을 권장합니다.'), 1200);
      }
    }
  }

  async function boot() {
    try {
      DB = await loadDatabaseAsync();
    } catch (error) {
      console.error(error);
      DB = migrateDatabase({});
      showToast('저장소를 초기화했습니다.');
    }
    initialize();
  }

  Object.assign(window, {
    switchTab, switchMode, openEquipmentManager, openSettings, closeSettings, showEquipmentForm, hideEquipmentForm,
    saveEquipment, editEquipment, selectEquipment, deleteEquipment, removeWorkPhoto, deleteHistoryRecord, startNewWorkRecord, editWorkRecord,
    exportBackup, importBackup, purgePhotos30, purgePhotos90, openDataSettings, closeDataSettings, saveSubmissionRoomUrl, clearSubmissionRoomUrl, openInstallGuide, closeInstallGuide, installAppShortcut, copySiteUrl,
    openFreePlanGuide, closeFreePlanGuide, continueEquipmentRegistration,
    openEquipmentFromAdmin, exportAdminCsv,
    openSubmissionModal, closeSubmissionModal, copyDailySubmission, shareDailySubmission
    , handleOperationPrimaryAction, openDayStatusPanel
    , openInspectionModal, closeInspectionModal, saveInspection, openFaultModal, closeFaultModal, saveFaultReport, resolveLatestFault
    , navigateBottom, openMoreMenu, closeMoreMenu, openAlertComingSoon, closeAlertComingSoon, openAlertsHub, closeAlertsHub, renderAlertsBadge, startNewMaintRecord, editMaintRecord, shareSelectedEquipmentDocs, clearEquipmentDocSelection, closeSponsorBanner, openPhotoSourcePicker, closePhotoSourcePicker, choosePhotoSource
  });

  boot();
})();
