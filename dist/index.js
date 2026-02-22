"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// proxy-server/index.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const youtube_caption_extractor_1 = require("youtube-caption-extractor");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const PORT = 4000;
app.get("/api/captions/:videoId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { videoId } = req.params;
        console.log(`Fetching captions for video: ${videoId}`);
        const subtitles = yield (0, youtube_caption_extractor_1.getSubtitles)({
            videoID: videoId,
            lang: "ja",
        });
        res.json({
            success: true,
            data: subtitles,
        });
    }
    catch (error) {
        console.error("Error fetching captions:", error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
}));
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
