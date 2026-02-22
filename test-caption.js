// test-caption.js
const { getSubtitles } = require("youtube-caption-extractor");

(async () => {
  // 여러 영상 테스트
  const videos = [
    { id: "cbqvxDTLMps", name: "원본" },
    { id: "dQw4w9WgXcQ", name: "Rick Astley (영어자막 있는 영상)" },
    { id: "9bZkp7q19f0", name: "Gangnam Style" },
  ];

  for (const video of videos) {
    console.log(`\n테스트: ${video.name} (${video.id})`);
    try {
      const subs = await getSubtitles({
        videoID: video.id,
        lang: "en", // 영어로 테스트
      });
      console.log("  결과:", subs ? subs.length : 0, "개");
    } catch (e) {
      console.error("  에러:", e.message);
    }
  }
})();
