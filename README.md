# Debate Live Translator (Live AI — Multi-Language)

Aplikacja lokalna do symultanicznego tłumaczenia debat, konferencji i wystąpień scenicznych w wielu językach (**PL, EN, DE, ES, IT, HU** oraz **Auto-detekcja** w dowolnym kierunku) na czytelne napisy na żywo wyświetlane na rzutniku, telebimie, telewizorze lub w OBS — ze zintegrowanym panelem slajdów, animowanych teł i biometrią głosową mówców.

---

## 🚀 Wdrożenie na nowym laptopie (Windows 10 / 11)

1. Sklonuj repozytorium lub pobierz paczkę ZIP i rozpakuj ją na dysku:
   ```powershell
   git clone https://github.com/Mojzesz1993/TranslatorSymultaniczny.git
   cd TranslatorSymultaniczny
   ```
2. Kliknij dwukrotnie plik **`Instaluj_Translator.bat`**.
   Instalator automatycznie:
   - sprawdzi (lub pobierze i zainstaluje) środowisko **Python 3.12** z obsługą **Tkinter**,
   - zainstaluje biblioteki **`numpy`**, **`onnxruntime`**, **`pypdfium2`**, **`Pillow`** oraz **`msvc-runtime`** (biblioteki C++ VC++),
   - zweryfikuje lokalny model biometrii głosowej **WeSpeaker CAM++ ONNX** (`models/wespeaker_campp.onnx`), silnik PDF/obrazów oraz moduły serwera,
   - sprawdzi dostępność Microsoft PowerPoint lub LibreOffice do konwersji plików `.ppt`/`.pptx`,
   - utworzy na Pulpicie skrót **`Debate Live Translator`**.

---

## ▶ Codzienne uruchomienie

1. Kliknij dwukrotnie **`Uruchom_Translator.bat`** (lub skrót na Pulpicie).
2. Aplikacja uruchomi lokalny serwer (`http://localhost:8765`) i otworzy **Panel Operatora** w przeglądarce (zalecany Google Chrome lub Microsoft Edge).
3. Kliknij **`🖥 OTWÓRZ EKRAN PREZENTACJI`**, przeciągnij okno na drugi ekran (rzutnik / TV) i naciśnij **`F`** (pełny ekran).
4. **Prezentacje, Animacje i Playlista (`http://localhost:8766`):** Kliknij **`📊 PANEL SLAJDÓW`** (dostępny także zdalnie w sieci LAN na tablecie/telefonie), aby wgrywać i sterować prezentacjami `.pptx`/`.ppt`/`.pdf`, planszami graficznymi oraz animacjami wideo/GIF z płynnym przenikaniem pętli (crossfade), playlistą wydarzenia i napisami na żywo.

Szczegółowa instrukcja obsługi znajduje się w pliku [INSTRUKCJA.md](./INSTRUKCJA.md).
