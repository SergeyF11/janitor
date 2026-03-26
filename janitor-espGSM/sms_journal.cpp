#include "sms_journal.h"
#include <time.h>

SmsJournal SmsLog;

static constexpr uint16_t SMSJ_MAGIC   = 0x534A;
static constexpr uint8_t  SMSJ_VERSION = 1;

// Смещение данных в файле после заголовка
static constexpr uint32_t DATA_OFFSET = sizeof(SmsJournalHeader);

// ── begin ─────────────────────────────────────────────────────
bool SmsJournal::begin() {
    _count = 0;

    if (!LittleFS.exists(SMSJ_FILE)) {
        // Создаём новый файл с заголовком
        memset(&_header, 0, sizeof(_header));
        _header.magic    = SMSJ_MAGIC;
        _header.version  = SMSJ_VERSION;
        _header.capacity = SMSJ_MAX_ENTRIES;
        _header.head     = 0;
        _header.unread   = 0;
        return _writeHeader();
    }

    if (!_readHeader()) return false;

    // Проверяем корректность заголовка
    if (_header.magic != SMSJ_MAGIC || _header.version != SMSJ_VERSION) {
        log_w("[SmsJournal] Invalid header, reinitializing");
        LittleFS.remove(SMSJ_FILE);
        return begin();
    }

    // Подсчитываем реальное кол-во записей
    File f = LittleFS.open(SMSJ_FILE, "r");
    if (!f) return false;
    uint32_t fileSize   = f.size();
    f.close();

    uint32_t dataSize   = fileSize - DATA_OFFSET;
    uint8_t  storedSlots = dataSize / sizeof(SmsJournalEntry);
    _count = min((uint8_t)storedSlots, (uint8_t)SMSJ_MAX_ENTRIES);

    return true;
}

// ── add ───────────────────────────────────────────────────────
bool SmsJournal::add(const char* number, const char* text, uint32_t ts) {
    SmsJournalEntry e;
    memset(&e, 0, sizeof(e));

    e.ts = ts > 0 ? ts : (uint32_t)time(nullptr);
    strncpy(e.number, number, SMSJ_NUMBER_LEN - 1);
    strncpy(e.text,   text,   SMSJ_TEXT_LEN   - 1);
    e.flags = 0;

    uint16_t slot = _header.head;

    if (!_writeEntry(slot, e)) return false;

    // Advance head
    _header.head = (_header.head + 1) % SMSJ_MAX_ENTRIES;
    _header.unread++;
    if (_header.unread > SMSJ_MAX_ENTRIES) _header.unread = SMSJ_MAX_ENTRIES;

    if (_count < SMSJ_MAX_ENTRIES) _count++;

    return _writeHeader();
}

// ── get ───────────────────────────────────────────────────────
// index 0 = самая новая запись
bool SmsJournal::get(uint8_t index, SmsJournalEntry& out) const {
    if (index >= _count) return false;
    uint16_t slot = _indexToSlot(index);
    return _readEntry(slot, out);
}

// ── markRead ─────────────────────────────────────────────────
bool SmsJournal::markRead(uint8_t index) {
    if (index >= _count) return false;
    uint16_t slot = _indexToSlot(index);

    SmsJournalEntry e;
    if (!_readEntry(slot, e)) return false;
    if (e.isRead()) return true;  // уже прочитано

    e.markRead();
    if (!_writeEntry(slot, e)) return false;

    if (_header.unread > 0) _header.unread--;
    return _writeHeader();
}

// ── markReplied ───────────────────────────────────────────────
bool SmsJournal::markReplied(uint8_t index) {
    if (index >= _count) return false;
    uint16_t slot = _indexToSlot(index);

    SmsJournalEntry e;
    if (!_readEntry(slot, e)) return false;

    e.markReplied();
    e.markRead();
    if (!_writeEntry(slot, e)) return false;

    if (!e.isRead() && _header.unread > 0) _header.unread--;
    return _writeHeader();
}

// ── markAllRead ───────────────────────────────────────────────
bool SmsJournal::markAllRead() {
    for (uint8_t i = 0; i < _count; i++) {
        uint16_t slot = _indexToSlot(i);
        SmsJournalEntry e;
        if (!_readEntry(slot, e)) continue;
        if (!e.isRead()) {
            e.markRead();
            _writeEntry(slot, e);
        }
    }
    _header.unread = 0;
    return _writeHeader();
}

// ── clear ─────────────────────────────────────────────────────
bool SmsJournal::clear() {
    LittleFS.remove(SMSJ_FILE);
    _count = 0;
    return begin();
}

// ── toJson ────────────────────────────────────────────────────
// Формат: {"unread":N,"entries":[{"ts":...,"from":"...","text":"...","read":false},...]}
size_t SmsJournal::toJson(char* buf, size_t bufSize, uint8_t maxEntries) const {
    uint8_t n = min((uint8_t)_count, maxEntries);
    size_t  pos = 0;

    pos += snprintf(buf + pos, bufSize - pos,
        "{\"unread\":%u,\"entries\":[", _header.unread);

    for (uint8_t i = 0; i < n && pos < bufSize - 4; i++) {
        SmsJournalEntry e;
        if (!get(i, e)) continue;

        // Экранируем кавычки в тексте
        char escaped[SMSJ_TEXT_LEN * 2];
        size_t ep = 0;
        for (size_t j = 0; e.text[j] && ep < sizeof(escaped) - 2; j++) {
            if (e.text[j] == '"' || e.text[j] == '\\')
                escaped[ep++] = '\\';
            escaped[ep++] = e.text[j];
        }
        escaped[ep] = '\0';

        pos += snprintf(buf + pos, bufSize - pos,
            "%s{\"i\":%u,\"ts\":%lu,\"from\":\"%s\",\"text\":\"%s\","
            "\"read\":%s,\"replied\":%s}",
            i > 0 ? "," : "",
            i,
            (unsigned long)e.ts,
            e.number,
            escaped,
            e.isRead()    ? "true" : "false",
            e.isReplied() ? "true" : "false"
        );
    }

    pos += snprintf(buf + pos, bufSize - pos, "]}");
    return pos;
}

// ── _indexToSlot ─────────────────────────────────────────────
// index 0 = последняя записанная = head - 1
uint16_t SmsJournal::_indexToSlot(uint8_t index) const {
    int32_t slot = (int32_t)_header.head - 1 - (int32_t)index;
    if (slot < 0) slot += SMSJ_MAX_ENTRIES;
    return (uint16_t)(slot % SMSJ_MAX_ENTRIES);
}

// ── I/O ───────────────────────────────────────────────────────
bool SmsJournal::_readHeader() {
    File f = LittleFS.open(SMSJ_FILE, "r");
    if (!f) return false;
    bool ok = f.read((uint8_t*)&_header, sizeof(_header)) == sizeof(_header);
    f.close();
    return ok;
}

bool SmsJournal::_writeHeader() {
    File f = LittleFS.open(SMSJ_FILE, "r+");
    if (!f) f = LittleFS.open(SMSJ_FILE, "w");
    if (!f) return false;
    f.seek(0);
    bool ok = f.write((uint8_t*)&_header, sizeof(_header)) == sizeof(_header);
    f.close();
    return ok;
}

bool SmsJournal::_readEntry(uint16_t slot, SmsJournalEntry& e) const {
    File f = LittleFS.open(SMSJ_FILE, "r");
    if (!f) return false;
    uint32_t offset = DATA_OFFSET + (uint32_t)slot * sizeof(SmsJournalEntry);
    f.seek(offset);
    bool ok = f.read((uint8_t*)&e, sizeof(e)) == sizeof(e);
    f.close();
    return ok && !e.isEmpty();
}

bool SmsJournal::_writeEntry(uint16_t slot, const SmsJournalEntry& e) {
    File f = LittleFS.open(SMSJ_FILE, "r+");
    if (!f) f = LittleFS.open(SMSJ_FILE, "w");
    if (!f) return false;
    uint32_t offset = DATA_OFFSET + (uint32_t)slot * sizeof(SmsJournalEntry);
    f.seek(offset);
    bool ok = f.write((uint8_t*)&e, sizeof(e)) == sizeof(e);
    f.close();
    return ok;
}
