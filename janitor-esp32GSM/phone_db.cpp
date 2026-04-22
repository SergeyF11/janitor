#include "phone_db.h"

PhoneDB PhoneBook;

// ── Хэш номера телефона ───────────────────────────────────────
// FNV-1a 32bit — быстро, равномерно, без зависимостей
uint32_t PhoneDB::_hashPhone(uint64_t phone) {
    uint32_t hash = 2166136261UL;
    for (uint8_t i = 0; i < 8; i++) {
        hash ^= (uint8_t)(phone & 0xFF);
        hash *= 16777619UL;
        phone >>= 8;
    }
    return hash;
}

// ── begin ─────────────────────────────────────────────────────
bool PhoneDB::begin() {
    memset(_hashTable, 0, sizeof(_hashTable));
    _count      = 0;
    _compacting = false;

    // Создать файлы если не существуют
    if (!LittleFS.exists(PHONEDB_DATA_FILE)) {
        File f = LittleFS.open(PHONEDB_DATA_FILE, "w");
        if (!f) return false;
        f.close();
    }
    if (!LittleFS.exists(PHONEDB_IDX_FILE)) {
        File f = LittleFS.open(PHONEDB_IDX_FILE, "w");
        if (!f) return false;
        f.close();
    }

    return _loadHashTable();
}

// ── Загрузка хэш-таблицы в RAM ───────────────────────────────
bool PhoneDB::_loadHashTable() {
    memset(_hashTable, 0, sizeof(_hashTable));
    _count = 0;

    if (!LittleFS.exists(PHONEDB_HASH_FILE)) return true;  // пустая БД — ок

    File f = LittleFS.open(PHONEDB_HASH_FILE, "r");
    if (!f) return false;

    HashRecord rec;
    while (f.read((uint8_t*)&rec, sizeof(rec)) == sizeof(rec)) {
        if (rec.offset == 0) continue;
        uint32_t bucket = rec.hash() % PHONEDB_HASH_BUCKETS;

        // Линейное пробирование при коллизии
        for (uint16_t i = 0; i < PHONEDB_HASH_BUCKETS; i++) {
            uint16_t slot = (bucket + i) % PHONEDB_HASH_BUCKETS;
            if (_hashTable[slot].offset == 0) {
                _hashTable[slot] = rec;
                _count++;
                break;
            }
        }
    }
    f.close();
    return true;
}

// ── Сохранить хэш-таблицу из RAM в файл ──────────────────────
bool PhoneDB::_saveHashEntry(uint32_t hash, uint16_t offset) {
    // Добавляем в RAM
    uint32_t bucket = hash % PHONEDB_HASH_BUCKETS;
    for (uint16_t i = 0; i < PHONEDB_HASH_BUCKETS; i++) {
        uint16_t slot = (bucket + i) % PHONEDB_HASH_BUCKETS;
        if (_hashTable[slot].offset == 0) {
            _hashTable[slot].setHash(hash);
            _hashTable[slot].offset = offset;
            //_hashTable[slot] = { hash, offset };
            break;
        }
    }

    // Перезаписываем файл целиком (хэш-таблица небольшая)
    File f = LittleFS.open(PHONEDB_HASH_FILE, "w");
    if (!f) return false;
    for (uint16_t i = 0; i < PHONEDB_HASH_BUCKETS; i++) {
        if (_hashTable[i].offset == 0) continue;
        f.write((uint8_t*)&_hashTable[i], sizeof(HashRecord));
    }
    f.close();
    return true;
}

// ── Удалить запись из хэш-таблицы ────────────────────────────
bool PhoneDB::_removeHashEntry(uint32_t hash, uint16_t offset) {
    for (uint16_t i = 0; i < PHONEDB_HASH_BUCKETS; i++) {
        if (_hashTable[i].hash() == hash && _hashTable[i].offset == offset) {
            _hashTable[i] = { 0, 0, 0 };
            break;
        }
    }

    File f = LittleFS.open(PHONEDB_HASH_FILE, "w");
    if (!f) return false;
    for (uint16_t i = 0; i < PHONEDB_HASH_BUCKETS; i++) {
        if (_hashTable[i].offset == 0) continue;
        f.write((uint8_t*)&_hashTable[i], sizeof(HashRecord));
    }
    f.close();
    return true;
}

// ── Чтение/запись записи данных ───────────────────────────────
bool PhoneDB::_writeDataRecord(uint16_t offset, const PhoneRecord& rec) {
    File f = LittleFS.open(PHONEDB_DATA_FILE, "r+");
    if (!f) {
        // Файл может не существовать при первой записи
        f = LittleFS.open(PHONEDB_DATA_FILE, "w");
        if (!f) return false;
    }
    f.seek((uint32_t)offset * sizeof(PhoneRecord));
    bool ok = f.write((uint8_t*)&rec, sizeof(PhoneRecord)) == sizeof(PhoneRecord);
    f.close();
    return ok;
}

bool PhoneDB::_readDataRecord(uint16_t offset, PhoneRecord& rec) const {
    File f = LittleFS.open(PHONEDB_DATA_FILE, "r");
    if (!f) return false;
    f.seek((uint32_t)offset * sizeof(PhoneRecord));
    bool ok = f.read((uint8_t*)&rec, sizeof(PhoneRecord)) == sizeof(PhoneRecord);
    f.close();
    return ok && rec.isValid();
}

// ── Чтение/запись записи индекса ─────────────────────────────
// Ищем в idx-файле запись с нужным idx
bool PhoneDB::_writeIdxRecord(uint16_t idx, uint16_t offset) {
    // Сначала ищем существующую запись
    File f = LittleFS.open(PHONEDB_IDX_FILE, "r+");
    if (!f) f = LittleFS.open(PHONEDB_IDX_FILE, "w");
    if (!f) return false;

    IdxRecord rec;
    uint32_t pos = 0;
    bool found = false;

    while (f.read((uint8_t*)&rec, sizeof(rec)) == sizeof(rec)) {
        if (rec.idx == idx) {
            // Перезаписать на месте
            f.seek(pos);
            rec.offset = offset;
            f.write((uint8_t*)&rec, sizeof(rec));
            found = true;
            break;
        }
        pos += sizeof(rec);
    }

    if (!found) {
        // Дописать в конец
        f.seek(0, SeekEnd);
        rec = { idx, offset };
        f.write((uint8_t*)&rec, sizeof(rec));
    }

    f.close();
    return true;
}

bool PhoneDB::_readIdxRecord(uint16_t idx, uint16_t& offset) const {
    File f = LittleFS.open(PHONEDB_IDX_FILE, "r");
    if (!f) return false;

    IdxRecord rec;
    while (f.read((uint8_t*)&rec, sizeof(rec)) == sizeof(rec)) {
        if (rec.idx == idx) {
            offset = rec.offset;
            f.close();
            return true;
        }
    }
    f.close();
    return false;
}

// ── Найти offset по idx ───────────────────────────────────────
bool PhoneDB::_findIdxOffset(uint16_t idx, uint16_t& offset) const {
    return _readIdxRecord(idx, offset);
}

// ── Следующий свободный offset в data-файле ──────────────────
uint16_t PhoneDB::_nextFreeOffset() const {
    File f = LittleFS.open(PHONEDB_DATA_FILE, "r");
    if (!f) return 1;  // 0 зарезервирован как "нет записи"
    uint16_t size = f.size() / sizeof(PhoneRecord);
    f.close();
    return size > 0 ? size : 1;
}

// ── add ───────────────────────────────────────────────────────
bool PhoneDB::add(uint64_t phone, uint8_t relays, uint16_t idx) {
    if (_count >= PHONEDB_MAX_RECORDS) return false;

    // Проверить — idx уже есть?
    uint16_t existingOffset;
    if (_findIdxOffset(idx, existingOffset) && existingOffset != 0) {
        // Уже есть — используем update
        return update(idx, phone, relays);
    }

    uint16_t offset = _nextFreeOffset();

    PhoneRecord rec;
    rec.init(phone, relays, idx);

    if (!_writeDataRecord(offset, rec)) return false;
    if (!_writeIdxRecord(idx, offset)) return false;

    uint32_t hash = _hashPhone(phone);
    if (!_saveHashEntry(hash, offset)) return false;

    _count++;
    return true;
}

// ── update ────────────────────────────────────────────────────
// Перезаписывает данные на том же offset — размер файла не меняется
bool PhoneDB::update(uint16_t idx, uint64_t phone, uint8_t relays) {
    uint16_t offset;
    if (!_findIdxOffset(idx, offset) || offset == 0) return false;

    // Читаем старую запись чтобы удалить старый хэш
    PhoneRecord old;
    if (_readDataRecord(offset, old)) {
        uint32_t oldHash = _hashPhone(old.getPhone());
        _removeHashEntry(oldHash, offset);
    }

    PhoneRecord rec;
    rec.init(phone, relays, idx);

    if (!_writeDataRecord(offset, rec)) return false;

    uint32_t newHash = _hashPhone(phone);
    return _saveHashEntry(newHash, offset);
    // idx-запись не меняется — offset тот же
}

// ── remove ────────────────────────────────────────────────────
bool PhoneDB::remove(uint16_t idx) {
    uint16_t offset;
    if (!_findIdxOffset(idx, offset) || offset == 0) return false;

    // Удалить из хэш-таблицы
    PhoneRecord rec;
    if (_readDataRecord(offset, rec)) {
        uint32_t hash = _hashPhone(rec.getPhone());
        _removeHashEntry(hash, offset);
    }

    // Пометить idx как удалённый (offset = 0)
    if (!_writeIdxRecord(idx, 0)) return false;

    if (_count > 0) _count--;
    return true;
}

// ── findByPhone ───────────────────────────────────────────────
PhoneLookup PhoneDB::findByPhone(uint64_t phone) const {
    uint32_t hash   = _hashPhone(phone);
    uint32_t bucket = hash % PHONEDB_HASH_BUCKETS;

    // Собираем все кандидаты с совпадающим хэшем
    struct Candidate { uint16_t offset; };
    Candidate candidates[4];
    uint8_t   candCount = 0;

    for (uint16_t i = 0; i < PHONEDB_HASH_BUCKETS && candCount < 4; i++) {
        uint16_t slot = (bucket + i) % PHONEDB_HASH_BUCKETS;
        if (_hashTable[slot].offset == 0) continue;
        if (_hashTable[slot].hash() == hash) {
            candidates[candCount++] = { _hashTable[slot].offset };
        }
    }

    if (candCount == 0) return { false, 0, 0 };

    // Один кандидат — хэш уникален, возвращаем без чтения файла
    // (вероятность коллизии ~0.01% при 256 записях)
    if (candCount == 1) {
        PhoneRecord rec;
        if (!_readDataRecord(candidates[0].offset, rec)) return { false, 0, 0 };
        if (rec.getPhone() != phone) return { false, 0, 0 };  // коллизия хэша
        return { true, rec.getIdx(), rec.getRelays() };
    }

    // Несколько кандидатов — проверяем полный номер
    for (uint8_t i = 0; i < candCount; i++) {
        PhoneRecord rec;
        if (!_readDataRecord(candidates[i].offset, rec)) continue;
        if (rec.getPhone() == phone) {
            return { true, rec.getIdx(), rec.getRelays() };
        }
    }

    return { false, 0, 0 };
}

// ── getByIdx ──────────────────────────────────────────────────
bool PhoneDB::getByIdx(uint16_t idx, PhoneRecord& out) const {
    uint16_t offset;
    if (!_findIdxOffset(idx, offset) || offset == 0) return false;
    return _readDataRecord(offset, out);
}

// ── count ─────────────────────────────────────────────────────
// _count обновляется в RAM, но пересчитываем при begin() из файла

// ── clear ─────────────────────────────────────────────────────
bool PhoneDB::clear() {
    LittleFS.remove(PHONEDB_DATA_FILE);
    LittleFS.remove(PHONEDB_IDX_FILE);
    LittleFS.remove(PHONEDB_HASH_FILE);
    memset(_hashTable, 0, sizeof(_hashTable));
    _count = 0;
    return begin();
}

// ── backupSize ────────────────────────────────────────────────
size_t PhoneDB::backupSize() const {
    // Заголовок (4) + все три файла с префиксом длины (4 байта каждый)
    size_t total = 4;  // magic + version
    File f;

    f = LittleFS.open(PHONEDB_DATA_FILE, "r");
    if (f) { total += 4 + f.size(); f.close(); }

    f = LittleFS.open(PHONEDB_IDX_FILE, "r");
    if (f) { total += 4 + f.size(); f.close(); }

    f = LittleFS.open(PHONEDB_HASH_FILE, "r");
    if (f) { total += 4 + f.size(); f.close(); }

    return total;
}

// ── backupToStream / restoreFromStream ────────────────────────
// Формат: [magic:2][ver:1][files:1][len:4][data:len] × 3
static constexpr uint16_t BACKUP_MAGIC = 0x4A44;  // "JD"
static constexpr uint8_t  BACKUP_VER   = 1;

bool PhoneDB::backupToStream(Stream& out) const {
    out.write((uint8_t*)&BACKUP_MAGIC, 2);
    out.write(BACKUP_VER);
    out.write((uint8_t)3);  // 3 файла

    const char* files[] = { PHONEDB_DATA_FILE, PHONEDB_IDX_FILE, PHONEDB_HASH_FILE };
    for (uint8_t i = 0; i < 3; i++) {
        File f = LittleFS.open(files[i], "r");
        uint32_t len = f ? f.size() : 0;
        out.write((uint8_t*)&len, 4);
        if (f) {
            uint8_t buf[64];
            size_t  rem = len;
            while (rem > 0) {
                size_t chunk = min(rem, sizeof(buf));
                f.read(buf, chunk);
                out.write(buf, chunk);
                rem -= chunk;
            }
            f.close();
        }
    }
    return true;
}

bool PhoneDB::restoreFromStream(Stream& in) {
    uint16_t magic; uint8_t ver; uint8_t nfiles;
    if (in.readBytes((char*)&magic, 2) != 2) return false;
    if (magic != BACKUP_MAGIC) return false;
    ver    = in.read();
    nfiles = in.read();
    if (ver != BACKUP_VER || nfiles != 3) return false;

    const char* files[] = { PHONEDB_DATA_FILE, PHONEDB_IDX_FILE, PHONEDB_HASH_FILE };
    for (uint8_t i = 0; i < 3; i++) {
        uint32_t len;
        if (in.readBytes((char*)&len, 4) != 4) return false;

        File f = LittleFS.open(files[i], "w");
        if (!f) return false;

        uint8_t buf[64];
        uint32_t rem = len;
        while (rem > 0) {
            uint32_t chunk = min(rem, (uint32_t)sizeof(buf));
            if (in.readBytes((char*)buf, chunk) != chunk) { f.close(); return false; }
            f.write(buf, chunk);
            rem -= chunk;
        }
        f.close();
    }

    return _loadHashTable();
}

// ── Компактификация (пошаговая) ───────────────────────────────
// Шаг 1: читаем data-файл, пропускаем записи с offset=0 в idx
// Шаг 2: записываем во временный файл
// Шаг 3: обновляем idx-файл с новыми offset
// Шаг 4: переименовываем tmp → data, пересчитываем хэш

bool PhoneDB::startCompaction() {
    if (_compacting) return false;
    _compacting  = true;
    _compactStep = 0;
    return true;
}

PhoneDB::CompactionResult PhoneDB::compactionStep() {
    if (!_compacting) return CompactionResult::IDLE;

    static File  _src, _dst;
    static uint16_t _newOffset;
    static PhoneRecord _rec;

    switch (_compactStep) {

    case 0: {
        // Открываем источник и временный файл
        _src = LittleFS.open(PHONEDB_DATA_FILE, "r");
        _dst = LittleFS.open("/ph_data.tmp", "w");
        if (!_src || !_dst) {
            _compacting = false;
            return CompactionResult::ERROR;
        }
        _newOffset = 1;  // 0 зарезервирован
        _compactStep = 1;
        return CompactionResult::IN_PROGRESS;
    }

    case 1: {
        // Читаем по одной записи
        if (_src.read((uint8_t*)&_rec, sizeof(_rec)) != sizeof(_rec)) {
            // Конец файла
            _src.close();
            _dst.close();
            _compactStep = 2;
            return CompactionResult::IN_PROGRESS;
        }

        if (!_rec.isValid()) return CompactionResult::IN_PROGRESS;  // пропускаем мусор

        uint16_t idx    = _rec.getIdx();
        uint16_t offset = 0;
        if (!_findIdxOffset(idx, offset) || offset == 0)
            return CompactionResult::IN_PROGRESS;  // удалённая запись — пропускаем

        // Записываем в tmp и обновляем idx
        _dst.write((uint8_t*)&_rec, sizeof(_rec));
        _writeIdxRecord(idx, _newOffset);
        _newOffset++;
        return CompactionResult::IN_PROGRESS;
    }

    case 2: {
        // Заменяем data → tmp, пересчитываем хэш
        LittleFS.remove(PHONEDB_DATA_FILE);
        LittleFS.rename("/ph_data.tmp", PHONEDB_DATA_FILE);
        LittleFS.remove(PHONEDB_HASH_FILE);
        _loadHashTable();  // пересчитываем хэш из нового idx + data
        _compacting = false;
        return CompactionResult::DONE;
    }

    default:
        _compacting = false;
        return CompactionResult::ERROR;
    }
}