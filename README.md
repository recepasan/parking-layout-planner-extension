# Otopark Yerleşim Planlayıcı (Test Eklentisi)

Google Maps üzerinde bir araziyi çizip **en verimli otopark yerleşimini gerçek metre ölçeğinde** görsel olarak gösteren Chrome/Edge eklentisi. Test/demo amaçlıdır.

## Nasıl çalışır?
- Haritanın üzerine şeffaf bir çizim katmanı (canvas) ve sağ üstte bir kontrol paneli ekler.
- Ölçeği, Google Maps URL'sindeki zoom değerinden Web Mercator formülüyle (`156543.03 · cos(enlem) / 2^zoom` m/piksel) otomatik hesaplar.
- Bağlı bir sürüş ağı üretmek için 0–180° arası farklı açılarda tek veya çoklu paralel koridorları dener; geniş alanlarda koridorları dik geçişle bağlar.
- Dış sınır boyunca, referans planlardaki gibi kenar çizgisine bitişik tek sıra park cepleri ekler.
- Çıktıyı vaziyet planı stilinde çizer: gri asfalt, beyaz park çizgileri, peyzaj adaları, erişilebilir parklar ve EV/özel park blokları.

## Kurulum
1. Chrome/Edge'de `chrome://extensions` adresini aç.
2. Sağ üstten **Geliştirici modu**'nu (Developer mode) aç.
3. **Paketlenmemiş öğe yükle** (Load unpacked) → bu klasörü (`otopark-eklenti`) seç.
4. `https://www.google.com/maps` adresine git, sayfayı yenile. Panel sağ üstte görünür.

## Kullanım
1. Haritayı **üstten (2B) görünümde** ve istediğin araziye yakınlaştır.
2. **Alan Çiz** → arazi köşelerini tıkla → başlangıç noktasına geri tıklayınca alan otomatik kapanır. İstersen yine **Bitir** / çift tık / Enter kullanabilirsin.
3. İstersen **Giriş Kapısı** ve **Çıkış Kapısı** ile sınır üzerinde kapı noktalarını seç.
4. İstersen park yeri/koridor ölçülerini değiştir; **Tek şerit yol** seçeneği 3.5 m koridor üretir, **Sırt sırta çift park** seçeneği önlü arkalı park bantlarını aç/kapatır.
5. **Yerleşimi Hesapla** → kapasite ve en iyi yön gösterilir.
6. **Yol Taşı** veya **Yol Sil** → gri sürüş koridorlarını elle düzenle. Yol Taşı modunda köşe/kenar tutamaçlarıyla yol boyunu ve açıklığını ayarlayabilirsin.
7. Ölçek sapıyorsa **Ölçek Kalibre** → bilinen uzunlukta bir çizginin iki ucunu tıkla → metresini gir.

## Bilinen sınırlar (test sürümü)
- Yerleşim coğrafi olarak sabitlenir (enlem/boylam): haritayı kaydırıp zoom yapabilir, harita ↔ uydu (2B) arasında geçebilirsiniz; çizim yerinde kalır.
- 3B/eğik görünümde düz projeksiyon hizalanamaz; hizalama duraklatılır ve 2B'ye dönünce otomatik düzelir. Çizim için üstten 2B görünüm kullanın.
- Konum, viewport merkezinde varsayılır; solda sonuç paneli açıksa (bir yer seçiliyken) hafif kayma olabilir. Boş harita görünümünde kullanın.
- Yasal kısıtlar (engelli yeri, yangın yolu, giriş/çıkış, mevcut engeller) henüz modellenmemiştir; algoritma erişilebilir kapasiteyi optimize eder.

## Sonraki adımlar (isteğe bağlı)
- Coğrafi sabitleme (harita kayınca yerleşimin sabit kalması).
- Dönüş cebi ve bina/peyzaj gibi iç engel çizme modu.
- Engelli/yangın yolu kuralları ve yerel imar standartları.
- DXF/PNG dışa aktarma.
