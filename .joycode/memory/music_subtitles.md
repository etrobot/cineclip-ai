---
name: music_subtitles_extraction
description: 字幕中 music 标记的自动提取逻辑
type: project
---

字幕中包含 `[music]`、`>> [music]` 等标记时，系统会自动将其合并提取为 "Music" clip。

**Why:** 用户要求 music 段落要整块提取，不依赖 LLM 分析。

**How to apply:**
1. `parseVTT` 中保留了 music 标记字幕，不做去重过滤
2. `detectMusicClips` 检测 `\bmusic\b`（不区分大小写）并合并连续段
3. `buildVideoContextBlock` 在 prompt 中标注 music 段落，LLM 不会把它们当作内容分析
4. 最终 clips = music clips + LLM 分析的内容 clips + 去重

已验证视频: TERAFAB (HcxEGykMZc4) - 前半对话 + 后半 music 正确分成 2 clips