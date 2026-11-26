# Debate Live Translator (Live AI) — Instrukcja Obsługi

Aplikacja lokalna przeznaczona do symultanicznego tłumaczenia debat, konferencji i wystąpień na żywo pomiędzy językami **polskim (PL), angielskim (EN), niemieckim (DE), hiszpańskim (ES), włoskim (IT), węgierskim (HU)** (wraz z trybem **Auto-wykrywania języka**) na wyraźne, duże napisy wyświetlane na rzutniku, telebimie, telewizorze lub w OBS.

---

## 1. Wdrożenie na nowym laptopie i Szybkie Uruchomienie

### A. Pierwsze uruchomienie na świeżym komputerze (Instalator)
1. Skopiuj cały folder projektu (lub sklonuj repozytorium) na laptop z systemem Windows 10 lub 11.
2. Kliknij dwukrotnie plik **`Instaluj_Translator.bat`**.
3. Instalator automatycznie:
   - sprawdzi (lub pobierze i zainstaluje) środowisko **Python 3.12** z obsługą `tkinter`,
   - zainstaluje biblioteki **`numpy`**, **`onnxruntime`**, **`pypdfium2`**, **`Pillow`** oraz **`msvc-runtime`** (wraz z lokalnymi bibliotekami C++ w `models/vc_redist`),
   - zweryfikuje obecność i działanie modelu biometrii głosowej **`models/wespeaker_campp.onnx`** oraz modułów prezentacji/PDF,
   - sprawdzi obsługę prezentacji `.ppt`/`.pptx` (Microsoft PowerPoint lub darmowy LibreOffice),
   - utworzy na Pulpicie skrót **`Debate Live Translator`**.

### B. Codzienne uruchomienie
1. Kliknij dwukrotnie plik **`Uruchom_Translator.bat`** (lub skrót na Pulpicie).
2. Skrypt zweryfikuje wymagane biblioteki (w razie braku automatycznie uruchomi instalator), wystartuje lokalny serwer i otworzy **Panel Operatora** (`http://localhost:8765/index.html`).
   > **Zalecana przeglądarka:** Google Chrome lub Microsoft Edge (zapewniają ciągłe rozpoznawanie mowy w ułamku sekundy oraz zapamiętują dostęp do mikrofonu).
   > **Ważne przy podłączeniu miksera / interfejsu audio:** W ustawieniach dźwięku Windows (`Ustawienia -> System -> Dźwięk -> Wejście`) ustaw wybrane wejście (np. mikser USB) jako **Domyślne urządzenie wejściowe** i wyłącz systemowe „Ulepszenia audio" / redukcję szumów dla tego wejścia.

---

## 2. Podłączenie Rzutnika / Drugiego Ekranu i Panel Slajdów

1. W górnym pasku **Panelu Operatora** kliknij **`🖥 OTWÓRZ EKRAN PREZENTACJI`**.
2. Otworzy się czyste okno sceniczne (`screen.html`). Przeciągnij je na drugi ekran (rzutnik / telebim / TV) i naciśnij klawisz **`F`** (lub kliknij dwukrotnie lewym przyciskiem myszy), aby włączyć **pełny ekran**.
3. Aby wyświetlać prezentacje, animacje tła lub kolejkę materiałów, kliknij **`📊 PANEL SLAJDÓW`** (`http://localhost:8766` — adres LAN do sterowania z tabletu/telefonu wyświetla się u góry panelu):
   - **Obsługiwane pliki:** prezentacje `.pptx`, `.ppt`, `.pdf`, obrazy statyczne (`.png`, `.jpg`, `.webp`) oraz animacje (`.mp4`, `.webm`, `.mov`, `.gif`, animowany `.webp`).
   - **Sterowanie animacjami i płynna pętla:** pasek transportu (`Play/Pause`, `Od początku`, suwak czasu, `Loop`) oraz wybór czasu **płynnego przenikania pętli (crossfade)** bez przeskoków i czarnych klatek.
   - **Playlista wydarzenia:** możliwość ułożenia kolejki prezentacji, plansz i animacji z indywidualnymi regułami zachowania pętli, kadrowania (`Cover`/`Contain`), przejść i widoczności napisów.
   - **Tryb Natywnego PowerPointa + Nakładka Always-On-Top:** opcjonalne sterowanie pełnoekranowym pokazem Microsoft PowerPoint z przezroczystą nakładką napisów na wybranym monitorze.

---

## 3. Konfiguracja Tła i Dużych Liter (Zakładka `🎨 Tło i Wygląd Liter`)

- **Własne tło z dysku:** Kliknij **`📁 Wybierz plik tła z dysku (Obraz / Wideo)...`**, aby wgrać oficjalną planszę graficzną konferencji (`JPG`, `PNG`, `WebP`) lub animowane tło wideo (`MP4`, `WebM`) z automatycznym płynnym zapętleniem.
- **Przyciemnienie i obrys liter:** Użyj suwaka **Przyciemnienie tła pod literami**, włącz **Mocny obrys + cień** albo zaznacz **Dodaj półprzezroczysty boks bezpośrednio pod napisami**.
- **Marginesy bezpieczne (Safe Area):** Suwaki **Góra / Dół / Lewo / Prawo** chronią logotypy sponsorów przed zasłonięciem przez napisy.
- **Tryb wyświetlania tekstu:**
  - **Teleprompter / Live Transcript (zalecany):** Pokazuje ostatnie 2–4 zdania (aktualne zdanie największe, poprzednie lekko przygaszone wyżej).
  - **Tylko aktualna wypowiedź:** Jedno duże zdanie wyśrodkowane na ekranie.
  - **Napisy u dołu ekranu:** Klasyczna belka napisów w dolnej części ekranu.

---

## 4. Konfiguracja Google Gemini API, Języków i Audio (Zakładka `🎙 Silnik AI i Audio`)

1. Wklej swój klucz **Google Gemini API** (z [Google AI Studio](https://aistudio.google.com/)) i kliknij **`⚡ Testuj połączenie`**.
2. Wybierz **Kierunek tłumaczenia** (język mówiony ➔ język napisów spośród `PL`, `EN`, `DE`, `ES`, `IT`, `HU` lub `Auto-wykrywanie`, z szybkim przełącznikiem `⇄`).
3. Wybierz **Tryb przetwarzania**:
   - **1. Hybryda (Web Speech na żywo + Gemini Flash)** *(Domyślny)* — najniższe opóźnienie z podglądem *Live Draft* w trakcie zdania oraz pełnym tłumaczeniem kontekstowym po jego zakończeniu.
   - **2. Bezpośredni strumień Audio ➔ Gemini Multimodal Audio API** — przesyła próbki dźwięku bezpośrednio do modelu Gemini (używany również przy auto-detekcji języka).
   - **3. Tryb Demo / Symulacja Debaty** — test wyglądu napisów i ekranu bez mikrofonu ani klucza API.
4. Wybierz **Urządzenie wejściowe Audio** i upewnij się, że pasek **AUDIO (VU-Meter)** reaguje na głos.

---

## 5. Biometria Głosu, Kontekst i Narzędzia Operatora Na Żywo

- **Rozpoznawanie Głosów (`🗣 Rozpoznawanie Głosów`):** Lokalna sieć neuronowa **WeSpeaker CAM++ ONNX** pozwala przyuczyć głosy prelegentów (z mikrofonu, z ostatnich 4 sekund wypowiedzi lub z pliku audio/wideo) i automatycznie podpisywać mówców kolorowymi etykietami.
- **Słowniczek i kontekst (`📚 Kontekst i Słowniczek`):** Wpisz temat wydarzenia, nazwiska prelegentów oraz skróty branżowe (dodatkowo Gemini automatycznie otrzymuje tekst i notatki z aktualnie wyświetlanego slajdu).
- **Edycja na żywo i szybkie wysłanie tekstu:** Popraw dowolne zdanie na liście **Historia Wypowiedzi** — zmiana natychmiast zaktualizuje się na ekranie głównym.
- **Pauza / Mute (`Ctrl + M`):** Szybkie wstrzymanie nasłuchiwania na czas przerwy technicznej.
- **Eksport po wydarzeniu:** Pobierz zapis spotkania w formacie **`💾 TXT`**, **`📄 MD`** lub **`🎬 SRT`**.
