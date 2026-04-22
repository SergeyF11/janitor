#pragma once
#include <Arduino.h>
#include <LittleFS.h>

// ── Файлы БД ──────────────────────────────────────────────────
#define PHONEDB_IDX_FILE   "/ph_idx.bin"   // индекс: idx → offset
#define PHONEDB_HASH_FILE  "/ph_hash.bin"  // хэш → offset (RAM-копия)
#define PHONEDB_DATA_FILE  "/ph_data.bin"  // данные записей

// ── Размеры ───────────────────────────────────────────────────
#define PHONEDB_MAX_RECORDS   256          // макс. записей
#define PHONEDB_HASH_BUCKETS  256          // размер хэш-таблицы в RAM

// ── Упакованная запись данных (8 байт) ────────────────────────
// Хранится в ph_data.bin
// Биты: [41:0] phoneNum, [45:42] relaysMap, [61:46] idx, [63:62] version
// Геттеры/сеттеры скрывают битовую упаковку — нет зависимости от компилятора
struct PhoneRecord {
    uint64_t _raw;

    // Версия формата записи — старшие 2 бита
    static constexpr uint64_t VERSION     = 1ULL;
    static constexpr uint64_t MASK_PHONE  = (1ULL << 42) - 1;
    static constexpr uint64_t MASK_RELAYS = 0xFULL;
    static constexpr uint64_t MASK_IDX    = 0xFFFFULL;
    static constexpr uint64_t MASK_VER    = 0x3ULL;

    uint64_t  getPhone()  const { return  _raw        & MASK_PHONE;  }
    uint8_t   getRelays() const { return (_raw >> 42)  & MASK_RELAYS; }
    uint16_t  getIdx()    const { return (_raw >> 46)  & MASK_IDX;    }
    uint8_t   getVer()    const { return (_raw >> 62)  & MASK_VER;    }

    void setPhone (uint64_t phone)  {
        _raw = (_raw & ~MASK_PHONE)               | (phone  & MASK_PHONE);
    }
    void setRelays(uint8_t relays) {
        _raw = (_raw & ~(MASK_RELAYS << 42))      | ((uint64_t)(relays & MASK_RELAYS) << 42);
    }
    void setIdx   (uint16_t idx)   {
        _raw = (_raw & ~(MASK_IDX   << 46))       | ((uint64_t)(idx    & MASK_IDX)    << 46);
    }
    void setVer   (uint8_t ver)    {
        _raw = (_raw & ~(MASK_VER   << 62))       | ((uint64_t)(ver    & MASK_VER)    << 62);
    }

    void init(uint64_t phone, uint8_t relays, uint16_t idx) {
        _raw = 0;
        setPhone(phone);
        setRelays(relays);
        setIdx(idx);
        setVer(VERSION);
    }

    bool isValid() const { return getVer() == VERSION; }
};
static_assert(sizeof(PhoneRecord) == 8, "PhoneRecord must be 8 bytes");

// ── Запись индекса (4 байта) ──────────────────────────────────
// idx → offset в ph_data.bin
// offset == 0 → запись удалена или не существует
struct IdxRecord {
    uint16_t idx;
    uint16_t offset;    // offset в ph_data.bin (в единицах sizeof(PhoneRecord))
};
static_assert(sizeof(IdxRecord) == 4, "IdxRecord must be 4 bytes");

// ── Запись хэш-таблицы (6 байт) ──────────────────────────────
// Загружается в RAM из ph_hash.bin при старте
struct HashRecord {
    //uint32_t hash;
    uint16_t hashH;      // 16 битов достаточно для 256 бакетов, хэш обрезается до 16 бит
    uint16_t hashL;      // для коллизий храним полный 32-битный хэш, разделённый на две части
    uint32_t hash() const { return ((uint32_t)hashH << 16) | hashL; }
    void setHash(uint32_t h) {
        hashH = (h >> 16) & 0xFFFF;
        hashL = h & 0xFFFF;
    }
    uint16_t offset;    // offset в ph_data.bin
};
static_assert(sizeof(HashRecord) == 6, "HashRecord must be 6 bytes");

// ── Результат поиска ──────────────────────────────────────────
struct PhoneLookup {
    bool      found;
    uint16_t  idx;
    uint8_t   relaysMap;
};

// ── Класс БД ─────────────────────────────────────────────────
class PhoneDB {
public:
    // Инициализация — загружает хэш-таблицу в RAM
    bool begin();

    // Добавить/заменить номер
    // phone    — номер в числовом виде (до 12 цифр)
    // relays   — битовая маска доступных реле
    // idx      — внешний ключ из postgres (gsm_phone_idx.id)
    // Возвращает false если idx уже есть → используйте update()
    bool add(uint64_t phone, uint8_t relays, uint16_t idx);

    // Обновить существующую запись по idx (номер или маску реле)
    bool update(uint16_t idx, uint64_t phone, uint8_t relays);

    // Удалить по idx
    bool remove(uint16_t idx);

    // Поиск по номеру телефона → idx + relaysMap
    PhoneLookup findByPhone(uint64_t phone) const;

    // Получить запись по idx (для ответа администратору)
    bool getByIdx(uint16_t idx, PhoneRecord& out) const;

    // Количество активных записей
    uint16_t count() const { return _count; }

    // Компактификация (пошаговая — вызывать в loop)
    bool startCompaction();
    enum class CompactionResult { IDLE, IN_PROGRESS, DONE, ERROR };
    CompactionResult compactionStep();
    bool isCompactionInProgress() const { return _compacting; }

    // Полный сброс
    bool clear();

    // Размер данных для бэкапа
    size_t backupSize() const;

    // Бэкап/восстановление — бинарный формат
    bool backupToStream(Stream& out) const;
    bool restoreFromStream(Stream& in);

private:
    // Хэш-таблица в RAM
    HashRecord _hashTable[PHONEDB_HASH_BUCKETS];
    uint16_t   _count       = 0;
    bool       _compacting  = false;
    uint16_t   _compactStep = 0;

    // Вспомогательные методы
    static uint32_t _hashPhone(uint64_t phone);
    bool   _loadHashTable();
    bool   _saveHashEntry(uint32_t hash, uint16_t offset);
    bool   _removeHashEntry(uint32_t hash, uint16_t offset);
    bool   _writeDataRecord(uint16_t offset, const PhoneRecord& rec);
    bool   _readDataRecord(uint16_t offset, PhoneRecord& rec) const;
    bool   _writeIdxRecord(uint16_t idx, uint16_t offset);
    bool   _readIdxRecord(uint16_t idx, uint16_t& offset) const;
    uint16_t _nextFreeOffset() const;
    bool   _findIdxOffset(uint16_t idx, uint16_t& offset) const;
};

extern PhoneDB PhoneBook;
