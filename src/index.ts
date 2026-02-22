// proxy-server/index.ts
// yt-dlp를 사용한 YouTube 자막 프록시 서버
import express, { Request, Response } from "express";
import cors from "cors";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4000;

interface Caption {
  start: string;
  dur: string;
  text: string;
}

app.get(
  "/api/captions/:videoId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { videoId } = req.params;
      console.log(`Fetching captions for video: ${videoId}`);

      const tempDir = os.tmpdir();
      const outputPath = path.join(tempDir, `caption_${videoId}_${Date.now()}`);

      // 언어 우선순위: ja → en
      const languages = ["ja", "en"];
      let subtitles: Caption[] = [];
      let usedLang = "";

      for (const lang of languages) {
        try {
          // yt-dlp로 자막 다운로드 (JSON3 형식)
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
        if (cleanLine) {
          textLines.push(cleanLine);
        }
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
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);
  return hours * 3600 + minutes * 60 + seconds;
}

// ============================================
// Uta-Net 가사 API (J-POP 전용)
// ============================================

app.get("/api/lyrics", async (req: Request, res: Response): Promise<void> => {
  try {
    const { artist, title } = req.query;

    if (!artist || !title) {
      res.status(400).json({
        success: false,
        error: "artist와 title 파라미터 필요",
      });
      return;
    }

    console.log(`Uta-Net 가사 검색: 아티스트(${artist}) - 곡명(${title})`);

    const searchTitle = title as string;
    const searchUrl = `https://www.uta-net.com/search/?Keyword=${encodeURIComponent(searchTitle)}&x=0&y=0`;

    console.log(`검색 URL: ${searchUrl}`);

    const searchResponse = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
      },
    });

    console.log(`검색 응답 상태: ${searchResponse.status}`);

    if (!searchResponse.ok) {
      const altSearchUrl = `https://www.uta-net.com/user/index_search/search2.html?md=&st=title&kw=${encodeURIComponent(searchTitle)}`;
      console.log(`대체 검색 URL 시도: ${altSearchUrl}`);

      const altResponse = await fetch(altSearchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "ja-JP,ja;q=0.9",
        },
      });

      if (!altResponse.ok) {
        throw new Error(`Uta-Net 검색 실패: ${altResponse.status}`);
      }
    }

    const searchHtml = await searchResponse.text();
    console.log(`검색 결과 HTML 길이: ${searchHtml.length}`);

    let songUrl: string | null = null;

    // 🔥 핵심 수정 사항: 정규식을 더욱 강력하게 변경했습니다.
    // <a> 태그 내부에 <span> 등 다른 태그가 포함되어 있어도 무시하고 추출하며,
    // 곡 링크 다음에 나오는 아티스트 링크를 정확하게 묶어서 가져옵니다.
    const songPattern =
      /href="(\/song\/\d+\/)"[^>]*>([\s\S]*?)<\/a>(?:(?!href="\/song\/)[\s\S])*?href="\/artist\/\d+\/"[^>]*>([\s\S]*?)<\/a>/g;

    const artistLower = (artist as string).toLowerCase();
    const artistNormalized = artistLower.replace(
      /[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g,
      "",
    );

    let match;
    const candidates: { url: string; title: string; artist: string }[] = [];

    // HTML 엔티티를 텍스트로 디코딩하는 헬퍼
    const decodeHtml = (html: string) => {
      return html
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
    };

    while ((match = songPattern.exec(searchHtml)) !== null) {
      // 캡처한 HTML에서 태그를 전부 날려버리고 순수 텍스트만 남김
      const rawTitle = decodeHtml(match[2].replace(/<[^>]*>/g, "")).trim();
      const rawArtist = decodeHtml(match[3].replace(/<[^>]*>/g, "")).trim();

      if (rawTitle && rawArtist) {
        candidates.push({
          url: match[1],
          title: rawTitle,
          artist: rawArtist,
        });
      }
    }

    console.log(`검색 결과 후보: ${candidates.length}개`);
    candidates.forEach((c, i) => {
      console.log(`  후보 ${i + 1}: ${c.title} - ${c.artist}`);
    });

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

    if (!songUrl) {
      const titleLower = (title as string).toLowerCase();
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
      res.status(404).json({
        success: false,
        error: "가사 스크래핑 실패",
      });
      return;
    }

    console.log(`가사 로드 완료: ${result.lyrics.length}자`);

    res.json({
      success: true,
      data: result,
    });
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
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`페이지 로드 실패: ${response.status}`);
    }

    const html = await response.text();

    let title = "";
    const titleMatch1 = html.match(/<h2[^>]*>([^<]+)<\/h2>/);
    const titleMatch2 = html.match(
      /class="[^"]*song-title[^"]*"[^>]*>([^<]+)</,
    );
    const titleMatch3 = html.match(/<title>([^<]+?)[\s\|]/);
    title = (
      titleMatch1?.[1] ||
      titleMatch2?.[1] ||
      titleMatch3?.[1] ||
      ""
    ).trim();

    let artist = "";
    const artistMatch1 = html.match(/itemprop="byArtist"[^>]*>([^<]+)</);
    const artistMatch2 = html.match(
      /class="[^"]*artist[^"]*"[^>]*><a[^>]*>([^<]+)</,
    );
    const artistMatch3 = html.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    artist = (
      artistMatch1?.[1] ||
      artistMatch2?.[1] ||
      artistMatch3?.[1] ||
      ""
    ).trim();

    let lyrics = "";
    const lyricsMatch = html.match(
      /<div[^>]*id="kashi_area"[^>]*>([\s\S]*?)<\/div>/,
    );

    if (lyricsMatch) {
      lyrics = lyricsMatch[1];
    } else {
      const altMatch = html.match(/itemprop="lyrics"[^>]*>([\s\S]*?)<\/div>/);
      if (altMatch) {
        lyrics = altMatch[1];
      }
    }

    if (!lyrics) {
      console.error("가사 영역을 찾을 수 없음");
      return null;
    }

    lyrics = lyrics.replace(/<br\s*\/?>/gi, "\n");
    lyrics = lyrics.replace(/<[^>]*>/g, "");
    lyrics = lyrics
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .trim();
    lyrics = lyrics.replace(/\n{3,}/g, "\n\n");

    console.log(
      `추출 완료 - 제목: ${title}, 아티스트: ${artist}, 가사길이: ${lyrics.length}`,
    );

    if (!lyrics) {
      return null;
    }

    return {
      title,
      artist,
      lyrics,
      url,
    };
  } catch (error) {
    console.error("Uta-Net 스크래핑 에러:", error);
    return null;
  }
}

// ============================================
// 스마트 자막 API (YouTube 자막 없으면 Aeneas 사용)
// ============================================

app.get(
  "/api/captions/smart/:videoId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { videoId } = req.params;
      const artist = req.query.artist as string;
      const title = req.query.title as string;
      const language = (req.query.language as string) || "ja";

      console.log(`\n========================================`);
      console.log(`스마트 자막 요청: ${videoId}`);
      console.log(`아티스트: ${artist}, 곡명: ${title}`);
      console.log(`========================================`);

      // 1. YouTube 자막 먼저 시도
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

      // 2. Uta-Net 가사 가져오기
      if (!artist || !title) {
        res.status(400).json({
          success: false,
          error: "YouTube 자막 없음. artist와 title 필요",
        });
        return;
      }

      console.log(`\n[2단계] Uta-Net 가사 가져오기...`);
      const lyricsResult = await fetchUtaNetLyrics(artist, title);

      if (!lyricsResult.success || !lyricsResult.lyrics) {
        res.status(404).json({
          success: false,
          error: "가사를 찾을 수 없음",
        });
        return;
      }

      console.log(`✅ 가사 발견! ${lyricsResult.lyrics.length}자`);

      // 3. Aeneas로 Forced Alignment (가사 + 오디오 → 타임스탬프)
      console.log(`\n[3단계] Aeneas Forced Alignment...`);
      const whisperResult = await fetchWhisperAlignment(
        videoId,
        lyricsResult.lyrics, // 가사 전달!
        language,
      );

      if (!whisperResult.success || whisperResult.segments.length === 0) {
        res.status(500).json({
          success: false,
          error: "Aeneas 처리 실패",
        });
        return;
      }

      console.log(
        `✅ Aeneas 완료! ${whisperResult.segments.length}개 세그먼트`,
      );

      // 4. 결과 반환 (이미 가사 + 타임스탬프 조합됨)
      console.log(`\n[4단계] 완료!`);

      res.json({
        success: true,
        source: "whisperx",
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

// YouTube 자막 가져오기 (내부 함수)
async function fetchYouTubeCaptions(videoId: string): Promise<{
  success: boolean;
  captions: Caption[];
  lang: string;
}> {
  const tempDir = os.tmpdir();
  const outputPath = path.join(tempDir, `caption_${videoId}_${Date.now()}`);
  const languages = ["ja", "en"];

  for (const lang of languages) {
    try {
      const command = `yt-dlp --write-sub --sub-lang ${lang} --sub-format json3 --skip-download -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}" --no-warnings 2>&1`;

      try {
        await execAsync(command, { timeout: 30000 });
      } catch (e) {
        // yt-dlp 출력 무시
      }

      const jsonPath = `${outputPath}.${lang}.json3`;

      if (fs.existsSync(jsonPath)) {
        const jsonContent = fs.readFileSync(jsonPath, "utf-8");
        const jsonData = JSON.parse(jsonContent);

        if (jsonData.events && jsonData.events.length > 0) {
          const captions = parseJson3Captions(jsonData.events);
          fs.unlinkSync(jsonPath);
          return { success: true, captions, lang };
        }
        fs.unlinkSync(jsonPath);
      }

      const vttPath = `${outputPath}.${lang}.vtt`;
      if (fs.existsSync(vttPath)) {
        const vttContent = fs.readFileSync(vttPath, "utf-8");
        const captions = parseVttCaptions(vttContent);
        fs.unlinkSync(vttPath);
        return { success: true, captions, lang };
      }
    } catch (e) {
      continue;
    }
  }

  return { success: false, captions: [], lang: "" };
}

// Uta-Net 가사 가져오기 (내부 함수)
async function fetchUtaNetLyrics(
  artist: string,
  title: string,
): Promise<{
  success: boolean;
  lyrics: string;
  songTitle: string;
  songArtist: string;
}> {
  try {
    const searchUrl = `https://www.uta-net.com/search/?Keyword=${encodeURIComponent(title)}&x=0&y=0`;

    const searchResponse = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "ja-JP,ja;q=0.9",
      },
    });

    if (!searchResponse.ok) {
      return { success: false, lyrics: "", songTitle: "", songArtist: "" };
    }

    const searchHtml = await searchResponse.text();

    const songPattern =
      /href="(\/song\/\d+\/)"[^>]*>([\s\S]*?)<\/a>(?:(?!href="\/song\/)[\s\S])*?href="\/artist\/\d+\/"[^>]*>([\s\S]*?)<\/a>/g;

    const decodeHtml = (html: string) => {
      return html
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
    };

    const artistLower = artist.toLowerCase();
    const artistNormalized = artistLower.replace(
      /[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g,
      "",
    );

    let match;
    while ((match = songPattern.exec(searchHtml)) !== null) {
      const rawArtist = decodeHtml(match[3].replace(/<[^>]*>/g, "")).trim();
      const candArtist = rawArtist
        .toLowerCase()
        .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, "");

      if (
        candArtist.includes(artistNormalized) ||
        artistNormalized.includes(candArtist) ||
        rawArtist.includes(artist) ||
        artist.includes(rawArtist)
      ) {
        const songUrl = `https://www.uta-net.com${match[1]}`;
        const result = await scrapeUtaNet(songUrl);

        if (result) {
          return {
            success: true,
            lyrics: result.lyrics,
            songTitle: result.title,
            songArtist: result.artist,
          };
        }
      }
    }

    return { success: false, lyrics: "", songTitle: "", songArtist: "" };
  } catch (error) {
    console.error("Uta-Net 에러:", error);
    return { success: false, lyrics: "", songTitle: "", songArtist: "" };
  }
}

// Aeneas Forced Alignment (가사 + 오디오)
async function fetchWhisperAlignment(
  videoId: string,
  lyrics: string,
  language: string,
): Promise<{
  success: boolean;
  segments: { text: string; start: number; end: number }[];
}> {
  try {
    const response = await fetch(`${ALIGNMENT_SERVER_URL}/api/align`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: videoId,
        lyrics: lyrics,
        language,
      }),
    });

    const data = await response.json();

    if (data.success && data.segments) {
      return { success: true, segments: data.segments };
    }

    return { success: false, segments: [] };
  } catch (error) {
    console.error("Aeneas Alignment 에러:", error);
    return { success: false, segments: [] };
  }
}

// Aeneas 타임스탬프 가져오기 (내부 함수)
async function fetchWhisperTimestamps(
  videoId: string,
  language: string,
): Promise<{
  success: boolean;
  segments: { text: string; start: number; end: number }[];
}> {
  try {
    const response = await fetch(`${ALIGNMENT_SERVER_URL}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId, language }),
    });

    const data = await response.json();

    if (data.success && data.segments) {
      return { success: true, segments: data.segments };
    }

    return { success: false, segments: [] };
  } catch (error) {
    console.error("Aeneas 에러:", error);
    return { success: false, segments: [] };
  }
}

// 가사와 타임스탬프 조합
function combineLyricsWithTimestamps(
  lyrics: string,
  segments: { text: string; start: number; end: number }[],
): Caption[] {
  // Aeneas 결과를 그대로 Caption 형식으로 변환
  // TODO: 실제 가사와 매칭하는 고급 로직 추가 가능

  return segments.map((seg) => ({
    start: seg.start.toFixed(3),
    dur: (seg.end - seg.start).toFixed(3),
    text: seg.text,
  }));
}

// ============================================
// Aeneas 연동 API
// ============================================

const ALIGNMENT_SERVER_URL =
  process.env.ALIGNMENT_SERVER_URL || "http://localhost:5000";

app.post(
  "/api/whisper/transcribe",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { video_id, language = "ja" } = req.body;

      if (!video_id) {
        res.status(400).json({
          success: false,
          error: "video_id 필요",
        });
        return;
      }

      console.log(`Aeneas transcribe: ${video_id} (${language})`);

      const response = await fetch(`${ALIGNMENT_SERVER_URL}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id, language }),
      });

      const data = await response.json();
      res.json(data);
    } catch (error) {
      console.error("Aeneas 에러:", error);
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

      if (!video_id || !lyrics) {
        res.status(400).json({
          success: false,
          error: "video_id와 lyrics 필요",
        });
        return;
      }

      console.log(`Aeneas align: ${video_id}`);

      const response = await fetch(`${ALIGNMENT_SERVER_URL}/api/align`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id, lyrics, language }),
      });

      const data = await response.json();
      res.json(data);
    } catch (error) {
      console.error("Aeneas 에러:", error);
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
  console.log(`Aeneas URL: ${ALIGNMENT_SERVER_URL}`);
});
