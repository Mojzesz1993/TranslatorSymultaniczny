# Debate Live Translator (PL ➔ EN) — Instrukcja Obsługi

Aplikacja lokalna przeznaczona do symultanicznego tłumaczenia debaty prowadzonej w języku polskim na wyraźne, duże napisy w języku angielskim wyświetlane na ekranie (rzutniku, telebimie, telewizorze lub w OBS).

---

## 1. Wdrożenie na nowym laptopie i Szybkie Uruchomienie

### A. Pierwsze uruchomienie na świeżym komputerze (Instalator)
1. Skopiuj cały folder **`Translator`** na nowy laptop z systemem Windows 10 lub 11.
2. Kliknij dwukrotnie plik **`Instaluj_Translator.bat`**.
3. Instalator automatycznie:
   - sprawdzi (lub pobierze i zainstaluje) środowisko **Python 3**,
   - doinstaluje biblioteki **`numpy`** oraz **`onnxruntime`** (obsługa lokalnej biometrii głosowej WeSpeaker CAM++),
   - zweryfikuje obecność modelu **`models/wespeaker_campp.onnx`**,
   - utworzy na Pulpicie skrót **`Debate Live Translator`**.

### B. Codzienne uruchomienie
1. Kliknij dwukrotnie plik **`Uruchom_Translator.bat`** (lub skrót na Pulpicie).
2. Skrypt uruchomi lokalny serwer w tle i automatycznie otworzy **Panel Operatora** (`http://localhost:8765/index.html`) w przeglądarce.
   > **Zalecana przeglądarka:** Google Chrome lub Microsoft Edge (zapewniają ciągłe rozpoznawanie mowy po polsku w ułamku sekundy oraz zapamiętują dostęp do mikrofonu).
   > **Ważne przy podłączeniu miksera / interfejsu audio:** W ustawieniach dźwięku Windows (`Ustawienia -> System -> Dźwięk -> Wejście`) ustaw wybrane wejście (np. mikser USB) jako **Domyślne urządzenie wejściowe**, a w systemie Windows wyłącz „Ulepszenia audio" / redukcję szumów dla tego wejścia.

---

## 2. Podłączenie Rzutnika / Drugiego Ekranu

1. W górnym pasku **Panelu Operatora** kliknij niebieski przycisk **`🖥 OTWÓRZ EKRAN PREZENTACJI`**.
2. Otworzy się nowe, czyste okno (`screen.html`).
3. Przeciągnij to okno na drugi ekran (rzutnik / telebim / TV) i naciśnij klawisz **`F`** (lub kliknij dwukrotnie lewym przyciskiem myszy), aby przełączyć je w **pełny ekran**.
4. Po 2 sekundach kursor myszy i przycisk pomocniczy znikną automatycznie — publiczność widzi wyłącznie wybrane przez Ciebie tło oraz duże litery tłumaczenia.

---

## 3. Konfiguracja Tła i Dużych Liter (Zakładka `🎨 Tło i Wygląd Liter`)

- **Własne tło z dysku:** Kliknij **`📁 Wybierz plik tła z dysku (Obraz / Wideo)...`**, aby wgrać oficjalną planszę graficzną konferencji (`JPG`, `PNG`, `WebP`) lub animowane tło wideo (`MP4`, `WebM`).
- **Przyciemnienie i obrys liter:** Jeśli grafika tła jest jasna, możesz zwiększyć suwak **Przyciemnienie tła pod literami**, włączyć **Mocny obrys + cień** albo zaznaczyć **Dodaj półprzezroczysty boks bezpośrednio pod napisami**.
- **Marginesy bezpieczne (Safe Area):** Jeśli na Twojej grafice tła na górze lub na dole znajdują się logotypy sponsorów, użyj suwaków **Góra / Dół / Lewo / Prawo**, aby napisy nigdy na nie nie nachodziły.
- **Tryb wyświetlania tekstu:**
  - **Teleprompter / Live Transcript (zalecany):** Pokazuje ostatnie 2–4 zdania (aktualne zdanie jest największe i najbardziej wyraziste, a poprzednie 1–2 zdania są lekko przygaszone wyżej, aby publiczność zdążyła doczytać).
  - **Tylko aktualna wypowiedź:** Jedno duże zdanie wyśrodkowane na ekranie.
  - **Napisy u dołu ekranu:** Klasyczna belka w dolnej części ekranu.

---

## 4. Konfiguracja Google Gemini API i Dźwięku (Zakładka `🎙 Silnik AI i Audio`)

1. Wklej swój klucz **Google Gemini API** (wygenerowany w [Google AI Studio](https://aistudio.google.com/)) i kliknij **`⚡ Testuj połączenie`**.
2. Wybierz **Tryb przetwarzania**:
   - **1. Hybryda (Web Speech PL na żywo + Gemini Flash)** *(Domyślny)* — błyskawicznie zamienia polską mowę na tekst i co sekundę aktualizuje angielskie tłumaczenie (Live Draft) w trakcie mówienia, a po zakończeniu zdania wygładza je z uwzględnieniem kontekstu debaty.
   - **2. Bezpośredni strumień Audio ➔ Gemini Multimodal Audio API** — przesyła próbki dźwięku z mikrofonu/miksera bezpośrednio do modelu Gemini.
   - **3. Tryb Demo / Symulacja Debaty** — pozwala przetestować wygląd napisów, czcionki i tła na rzutniku jeszcze przed podłączeniem mikrofonu lub klucza API.
3. Wybierz odpowiednie **Urządzenie wejściowe Audio** (np. interfejs USB podłączony do miksera nagłośnieniowego sali lub mikrofon) i upewnij się, że podczas mówienia zielony pasek **AUDIO (VU-Meter)** na górze ekranu reaguje na głos.

---

## 5. Kontekst Debaty i Narzędzia Operatora Na Żywo

- **Słowniczek i nazwiska (`📚 Kontekst i Słowniczek`):** Przed debatą wpisz temat spotkania, nazwiska prelegentów oraz nazwy firm/instytucji — Gemini będzie automatycznie korygować ewentualne błędy fonetyczne.
- **Edycja na żywo:** Jeśli na ekranie pojawi się literówka, możesz poprawić dowolne zdanie bezpośrednio na liście **Historia Wypowiedzi** — zmiana w tym samym ułamku sekundy zaktualizuje się na rzutniku.
- **Pauza / Mute (`Ctrl + M`):** Szybkie wstrzymanie nasłuchiwania na czas przerwy technicznej.
- **Eksport po debacie:** Po zakończeniu spotkania kliknij **`💾 Eksport TXT`**, **`📄 Eksport MD`** lub **`🎬 Eksport SRT`**, aby pobrać pełny dwujęzyczny zapis całej debaty.
