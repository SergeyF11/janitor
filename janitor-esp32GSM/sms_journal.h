#pragma once
#include <Arduino.h>
#include <LittleFS.h>

// ── Файл журнала ──────────────────────────────────────────────
#define SMSJ_FILE        "/sms_journal.bin"
#define SMSJ_MAX_ENTRIES  32       // кольцевой буфер — макс. записей
#define SMSJ_NUMBER_LEN   16       // макс. длина номера (включая \0)
#define SMSJ_TEXT_LEN     81       // макс. длина текста SMS (включая \0)

// ── Запись журнала (фиксированный размер) ─────────────────────
// Итого: 4 + 16 + 81 + 1 = 102 байта
struct SmsJournalEntry {
    uint32_t ts;                    // unix timestamp
    char     number[SMSJ_NUMBER_LEN]; // номер отправителя
    char     text[SMSJ_TEXT_LEN];   // текст SMS
    uint8_t  flags;                 // бит 0: прочитано, бит 1: ответ отправлен
    uint16_t  reserved;              // зарезервировано, должно быть 0

    bool isRead()         const { return flags & 0x01; }
    bool isReplied()      const { return flags & 0x02; }
    void markRead()             { flags |=  0x01; }
    void markReplied()          { flags |=  0x02; }
    bool isEmpty()        const { return ts == 0; }
};
static_assert(sizeof(SmsJournalEntry) == 104, "SmsJournalEntry size mismatch");

// ── Заголовок файла (8 байт) ──────────────────────────────────
struct SmsJournalHeader {
    uint16_t magic;     // 0x534A "SJ"
    uint8_t  version;   // 1
    uint8_t  capacity;  // SMSJ_MAX_ENTRIES
    uint16_t head;      // индекс следующей записи для записи (0..capacity-1)
    uint16_t unread;    // счётчик непрочитанных
};
static_assert(sizeof(SmsJournalHeader) == 8, "SmsJournalHeader size mismatch");

// ── Класс журнала ─────────────────────────────────────────────
class SmsJournal {
public:
    bool begin();

    // Добавить запись (кольцевой буфер — старые перезаписываются)
    bool add(const char* number, const char* text, uint32_t ts = 0);

    // Получить запись по индексу (0 = самая новая)
    bool get(uint8_t index, SmsJournalEntry& out) const;

    // Количество записей (не более SMSJ_MAX_ENTRIES)
    uint8_t count() const { return _count; }

    // Количество непрочитанных
    uint16_t unreadCount() const { return _header.unread; }

    // Пометить запись как прочитанную
    bool markRead(uint8_t index);

    // Пометить как отвеченную
    bool markReplied(uint8_t index);

    // Пометить все как прочитанные
    bool markAllRead();

    // Очистить журнал
    bool clear();

    // Сериализовать все записи в JSON (для MQTT ответа)
    // Пишет в переданный буфер, возвращает длину
    size_t toJson(char* buf, size_t bufSize, uint8_t maxEntries = 10) const;

private:
    SmsJournalHeader _header;
    uint8_t          _count = 0;   // реальное кол-во записей

    bool _readHeader();
    bool _writeHeader();
    bool _readEntry(uint16_t slot, SmsJournalEntry& e) const;
    bool _writeEntry(uint16_t slot, const SmsJournalEntry& e);

    // Преобразование: внешний индекс (0=новейший) → слот в файле
    uint16_t _indexToSlot(uint8_t index) const;
};

extern SmsJournal SmsLog;
