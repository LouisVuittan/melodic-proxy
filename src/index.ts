// proxy-server/index.ts
// yt-dlp와 Whisper API를 사용한 YouTube 스마트 자막 프록시 서버
import express, { Request, Response } from "express";
import cors from "cors";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as cheerio from "cheerio";

const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4000;
const WHISPER_SERVER_URL = "https://7f3e-34-168-154-170.ngrok-free.app";

interface Caption {
  start: string;
  dur: string;
  text: string;
}

// ============================================
// 유틸리티 및 보안 함수
// ============================================

// Command Injection 방지를 위한 YouTube ID 검증
const isValidVideoId = (id: string): boolean => {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
};

function parseJson3Captions(events: any[]): Caption[] {
  const captions: Caption[] = [];
  for (const event of events) {
    if (!event.segs) continue;
    const text = event.segs
      .map((seg: any) => seg.utf8 || "")
      .join("")
      .trim();
    if (!text) continue;
    const startMs = event.tStartMs || 0;
    const durationMs = event.dDurationMs || 3000;
    captions.push({
      start: (startMs / 1000).toFixed(3),
      dur: (durationMs / 1000).toFixed(3),
      text: text,
    });
  }
  return captions;
}

function parseVttCaptions(vtt: string): Caption[] {
  const captions: Caption[] = [];
  const lines = vtt.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const timeMatch = line.match(
      /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/,
    );
    if (timeMatch) {
      const startTime = parseVttTime(timeMatch[1]);
      const endTime = parseVttTime(timeMatch[2]);
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const cleanLine = lines[i].replace(/<[^>]*>/g, "").trim();
        if (cleanLine) textLines.push(cleanLine);
        i++;
      }
      const text = textLines.join(" ").trim();
      if (text) {
        captions.push({
          start: startTime.toFixed(3),
          dur: (endTime - startTime).toFixed(3),
          text: text,
        });
      }
    }
    i++;
  }
  return captions;
}

function parseVttTime(time: string): number {
  const parts = time.split(":");
  return (
    parseInt(parts[0], 10) * 3600 +
    parseInt(parts[1], 10) * 60 +
    parseFloat(parts[2])
  );
}

// ============================================
// 1. YouTube 자막 직접 추출 API
// ============================================

app.get(
  "/api/captions/:videoId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { videoId } = req.params;

      // 보안: 비디오 ID 검증
      if (!isValidVideoId(videoId)) {
        res.status(400).json({
          success: false,
          error: "유효하지 않은 YouTube 비디오 ID입니다.",
        });
        return;
      }

      console.log(`Fetching captions for video: ${videoId}`);

      const tempDir = os.tmpdir();
      const outputPath = path.join(tempDir, `caption_${videoId}_${Date.now()}`);

      const languages = ["ja", "en"];
      let subtitles: Caption[] = [];
      let usedLang = "";

      for (const lang of languages) {
        try {
          const command = `yt-dlp --write-sub --sub-lang ${lang} --sub-format json3 --skip-download -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}" --no-warnings 2>&1`;
          console.log(`Trying language: ${lang}`);

          try {
            await execAsync(command, { timeout: 30000 });
          } catch (execError: any) {
            console.log(
              `yt-dlp output: ${execError.stdout || execError.stderr || ""}`,
            );
          }

          const jsonPath = `${outputPath}.${lang}.json3`;
          if (fs.existsSync(jsonPath)) {
            const jsonContent = fs.readFileSync(jsonPath, "utf-8");
            const jsonData = JSON.parse(jsonContent);
            if (jsonData.events && jsonData.events.length > 0) {
              subtitles = parseJson3Captions(jsonData.events);
              usedLang = lang;
              fs.unlinkSync(jsonPath);
              console.log(`✓ Found ${subtitles.length} captions in ${lang}`);
              break;
            }
            fs.unlinkSync(jsonPath);
          }

          const vttPath = `${outputPath}.${lang}.vtt`;
          if (fs.existsSync(vttPath)) {
            const vttContent = fs.readFileSync(vttPath, "utf-8");
            subtitles = parseVttCaptions(vttContent);
            usedLang = lang;
            fs.unlinkSync(vttPath);
            console.log(
              `✓ Found ${subtitles.length} captions in ${lang} (VTT)`,
            );
            break;
          }
        } catch (e) {
          console.log(`Language ${lang} failed:`, e);
        }
      }

      if (subtitles.length === 0) {
        console.warn("No subtitles found for video:", videoId);
        res.status(404).json({
          success: false,
          message: "No captions found for this video",
          videoId,
        });
        return;
      }

      console.log(
        `Successfully fetched ${subtitles.length} captions (${usedLang})`,
      );
      res.json({
        success: true,
        data: subtitles,
        length: subtitles.length,
        lang: usedLang,
      });
    } catch (error) {
      console.error("Error fetching captions:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

// ============================================
// 2. Uta-Net 가사 API (J-POP 전용) - Cheerio 적용
// ============================================

app.get("/api/lyrics", async (req: Request, res: Response): Promise<void> => {
  try {
    const { artist, title } = req.query;

    if (!artist || !title) {
      res
        .status(400)
        .json({ success: false, error: "artist와 title 파라미터 필요" });
      return;
    }

    console.log(`Uta-Net 가사 검색: 아티스트(${artist}) - 곡명(${title})`);
    const searchTitle = title as string;
    const searchUrl = `https://www.uta-net.com/search/?Keyword=${encodeURIComponent(searchTitle)}&x=0&y=0`;
    console.log(`검색 URL: ${searchUrl}`);

    let searchResponse = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ja-JP,ja;q=0.9",
      },
    });

    console.log(`검색 응답 상태: ${searchResponse.status}`);

    // 원래 있던 대체 검색(Fallback) 로직 복구
    if (!searchResponse.ok) {
      const altSearchUrl = `https://www.uta-net.com/user/index_search/search2.html?md=&st=title&kw=${encodeURIComponent(searchTitle)}`;
      console.log(`대체 검색 URL 시도: ${altSearchUrl}`);
      searchResponse = await fetch(altSearchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept-Language": "ja-JP,ja;q=0.9",
        },
      });
      if (!searchResponse.ok)
        throw new Error(`Uta-Net 검색 실패: ${searchResponse.status}`);
    }

    const searchHtml = await searchResponse.text();
    console.log(`검색 결과 HTML 길이: ${searchHtml.length}`);

    const $ = cheerio.load(searchHtml);
    let songUrl: string | null = null;

    const candidates: { url: string; title: string; artist: string }[] = [];

    // Cheerio를 이용한 우타넷 검색 결과 테이블 파싱
    $('a[href^="/song/"]').each((_, el) => {
      const url = $(el).attr("href");
      const rawTitle = $(el).text().trim();
      const rawArtist = $(el)
        .closest("tr")
        .find('a[href^="/artist/"]')
        .text()
        .trim();
      if (url && rawTitle && rawArtist) {
        candidates.push({ url, title: rawTitle, artist: rawArtist });
      }
    });

    console.log(`검색 결과 후보: ${candidates.length}개`);
    candidates.forEach((c, i) =>
      console.log(`  후보 ${i + 1}: ${c.title} - ${c.artist}`),
    );

    const artistNormalized = (artist as string)
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, "");

    // 아티스트 매칭
    for (const candidate of candidates) {
      const candArtist = candidate.artist
        .toLowerCase()
        .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, "");
      if (
        candArtist.includes(artistNormalized) ||
        artistNormalized.includes(candArtist) ||
        candidate.artist.includes(artist as string) ||
        (artist as string).includes(candidate.artist)
      ) {
        songUrl = `https://www.uta-net.com${candidate.url}`;
        console.log(
          `아티스트 매칭 성공: ${candidate.title} - ${candidate.artist}`,
        );
        break;
      }
    }

    // 아티스트 매칭 실패 시 제목으로 매칭 시도
    if (!songUrl) {
      const titleLower = searchTitle.toLowerCase();
      for (const candidate of candidates) {
        const candTitle = candidate.title.toLowerCase();
        if (candTitle.includes(titleLower) || titleLower.includes(candTitle)) {
          songUrl = `https://www.uta-net.com${candidate.url}`;
          console.log(`제목 매칭: ${candidate.title} - ${candidate.artist}`);
          break;
        }
      }
    }

    if (!songUrl) {
      console.log("검색 결과에서 매칭되는 곡 URL을 찾을 수 없음");
      res.status(404).json({
        success: false,
        error: "정확하게 일치하는 가사 검색 결과 없음",
      });
      return;
    }

    console.log(`최종 곡 URL 발견: ${songUrl}`);
    const result = await scrapeUtaNet(songUrl);

    if (!result) {
      res.status(404).json({ success: false, error: "가사 스크래핑 실패" });
      return;
    }

    console.log(`가사 로드 완료: ${result.lyrics.length}자`);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Uta-Net API 에러:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

async function scrapeUtaNet(url: string): Promise<{
  title: string;
  artist: string;
  lyrics: string;
  url: string;
} | null> {
  try {
    console.log(`가사 페이지 요청: ${url}`);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ja-JP,ja;q=0.9",
      },
    });
    if (!response.ok) throw new Error(`페이지 로드 실패: ${response.status}`);

    const html = await response.text();
    const $ = cheerio.load(html);

    const title =
      $("h2").first().text().trim() || $(".song-title").first().text().trim();
    const artist =
      $('[itemprop="byArtist"]').first().text().trim() ||
      $(".artist a").first().text().trim();

    let lyricsHtml = $("#kashi_area").html() || $('[itemprop="lyrics"]').html();
    if (!lyricsHtml) {
      console.error("가사 영역을 찾을 수 없음");
      return null;
    }

    lyricsHtml = lyricsHtml.replace(/<br\s*\/?>/gi, "\n");
    const $lyrics = cheerio.load(lyricsHtml);
    let lyrics = $lyrics.root().text().trim(); // .root() 를 추가!
    lyrics = lyrics.replace(/\n{3,}/g, "\n\n");

    console.log(
      `추출 완료 - 제목: ${title}, 아티스트: ${artist}, 가사길이: ${lyrics.length}`,
    );
    return lyrics ? { title, artist, lyrics, url } : null;
  } catch (error) {
    console.error("Uta-Net 스크래핑 에러:", error);
    return null;
  }
}

// ============================================
// 3. 스마트 자막 API (YouTube 자막 없으면 Whisper 사용)
// ============================================

app.get(
  "/api/captions/smart/:videoId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { videoId } = req.params;

      if (!isValidVideoId(videoId)) {
        res.status(400).json({
          success: false,
          error: "유효하지 않은 YouTube 비디오 ID입니다.",
        });
        return;
      }

      const artist = req.query.artist as string;
      const title = req.query.title as string;
      const language = (req.query.language as string) || "ja";

      console.log(`\n========================================`);
      console.log(`스마트 자막 요청: ${videoId}`);
      console.log(`아티스트: ${artist}, 곡명: ${title}`);
      console.log(`========================================`);

      // [1단계] YouTube 자막 체크
      console.log(`\n[1단계] YouTube 자막 체크...`);
      const youtubeResult = await fetchYouTubeCaptions(videoId);
      if (youtubeResult.success && youtubeResult.captions.length > 0) {
        console.log(`✅ YouTube 자막 발견! ${youtubeResult.captions.length}개`);
        res.json({
          success: true,
          source: "youtube",
          data: youtubeResult.captions,
          length: youtubeResult.captions.length,
          lang: youtubeResult.lang,
        });
        return;
      }

      console.log(`❌ YouTube 자막 없음`);
      if (!artist || !title) {
        res.status(400).json({
          success: false,
          error: "YouTube 자막 없음. artist와 title 필요",
        });
        return;
      }

      // [2단계] Uta-Net 가사 가져오기
      console.log(`\n[2단계] Uta-Net 가사 가져오기...`);
      const searchUrl = `http://localhost:${PORT}/api/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
      const lyricsResponse = await fetch(searchUrl);
      const lyricsData = await lyricsResponse.json();

      if (!lyricsData.success || !lyricsData.data || !lyricsData.data.lyrics) {
        res.status(404).json({ success: false, error: "가사를 찾을 수 없음" });
        return;
      }

      const lyricsText = lyricsData.data.lyrics;
      console.log(`✅ 가사 발견! ${lyricsText.length}자`);

      // [3단계] Whisper Forced Alignment
      console.log(`\n[3단계] Whisper Forced Alignment...`);
      const whisperResponse = await fetch(`${WHISPER_SERVER_URL}/api/align`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true", // 👈 이 암구호를 꼭 추가해 주세요!
        },
        body: JSON.stringify({
          video_id: videoId,
          lyrics: lyricsText,
          language,
        }),
      });

      const whisperResult = await whisperResponse.json();

      if (
        !whisperResult.success ||
        !whisperResult.segments ||
        whisperResult.segments.length === 0
      ) {
        res.status(500).json({ success: false, error: "Whisper 처리 실패" });
        return;
      }

      console.log(
        `✅ Whisper 완료! ${whisperResult.segments.length}개 세그먼트`,
      );
      console.log(`\n[4단계] 완료!`);

      res.json({
        success: true,
        source: "whisper",
        data: whisperResult.segments.map((seg: any) => ({
          start: seg.start.toString(),
          dur: (seg.end - seg.start).toFixed(3),
          text: seg.text,
        })),
        length: whisperResult.segments.length,
        lang: language,
      });
    } catch (error) {
      console.error("스마트 자막 에러:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

async function fetchYouTubeCaptions(
  videoId: string,
): Promise<{ success: boolean; captions: Caption[]; lang: string }> {
  const tempDir = os.tmpdir();
  const outputPath = path.join(tempDir, `caption_${videoId}_${Date.now()}`);

  try {
    // 1. 현재 영상에 존재하는 모든 자막 리스트를 먼저 출력해봅니다.
    // --- 여기부터 추가 ---
    try {
      console.log(`\n[검토] 영상(${videoId}) 자막 리스트 확인...`);
      // --list-subs 옵션은 실제로 다운로드하지 않고 영상의 자막 목록만 표로 보여줍니다.
      const { stdout: subList } = await execAsync(
        `yt-dlp --list-subs "https://www.youtube.com/watch?v=${videoId}"`,
      );
      console.log("================ YouTube Subtitle List ================");
      console.log(subList);
      console.log("=======================================================");
    } catch (listError) {
      console.log(
        "[경고] 자막 리스트를 불러올 수 없습니다. (영상 삭제 혹은 차단 등)",
      );
    }
    // 2. 자막 추출 시도 (자동 생성 자막까지 포함하도록 옵션 강화)
    // --write-auto-sub: 자동 생성 자막 허용
    for (const lang of ["ja"]) {
      console.log(`[시도] ${lang} 자막 다운로드 시도 중...`);
      // index.ts 수정 제안
      const command = `yt-dlp --write-sub --all-subs --sub-format json3/vtt --skip-download \
  --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  --extractor-args "youtube:player_client=android,web" \
  -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}"`;

      try {
        await execAsync(command, { timeout: 30000 });
      } catch (e) {
        // 에러 발생 시 로그 출력
        console.log(
          `${lang} 추출 중 에러 발생(무시하고 다음 단계 진행):`,
          (e as any).message,
        );
      }

      const jsonPath = `${outputPath}.${lang}.json3`;
      if (fs.existsSync(jsonPath)) {
        const captions = parseJson3Captions(
          JSON.parse(fs.readFileSync(jsonPath, "utf-8")).events || [],
        );
        if (captions.length > 0) {
          fs.unlinkSync(jsonPath); // 사용 후 삭제
          return { success: true, captions, lang };
        }
      }

      // VTT 파일 체크 로직 (생략 가능하나 유지)
      const vttPath = `${outputPath}.${lang}.vtt`;
      if (fs.existsSync(vttPath)) {
        const captions = parseVttCaptions(fs.readFileSync(vttPath, "utf-8"));
        fs.unlinkSync(vttPath);
        if (captions.length > 0) return { success: true, captions, lang };
      }
    }
  } catch (globalError) {
    console.error("자막 체크 중 치명적 오류:", globalError);
  }

  return { success: false, captions: [], lang: "" };
}

// ============================================
// 4. Whisper 연동 API (Proxy)
// ============================================

app.post(
  "/api/whisper/transcribe",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { video_id, language = "ja" } = req.body;
      if (!video_id || !isValidVideoId(video_id)) {
        res.status(400).json({ success: false, error: "올바른 video_id 필요" });
        return;
      }
      console.log(`Whisper transcribe: ${video_id} (${language})`);
      const response = await fetch(`${WHISPER_SERVER_URL}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id, language }),
      });
      res.json(await response.json());
    } catch (error) {
      console.error("Whisper 에러:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

app.post(
  "/api/whisper/align",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { video_id, lyrics, language = "ja" } = req.body;
      if (!video_id || !isValidVideoId(video_id) || !lyrics) {
        res
          .status(400)
          .json({ success: false, error: "올바른 video_id와 lyrics 필요" });
        return;
      }
      console.log(`Whisper align: ${video_id}`);
      const response = await fetch(`${WHISPER_SERVER_URL}/api/align`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id, lyrics, language }),
      });
      res.json(await response.json());
    } catch (error) {
      console.error("Whisper 에러:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`Using yt-dlp for caption extraction`);
  console.log(`Whisper Server URL: ${WHISPER_SERVER_URL}`);
});
