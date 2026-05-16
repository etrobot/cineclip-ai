# Shot Segmentation 迭代计划

## 背景

当前系统通过 LLM 分析字幕将视频切成 clips。每次 clip 产生时，grid.ts 已提取采样帧（带时间戳）。下一步用 VL_MODEL 分析这些帧 + 字幕，将 clip 进一步分割成 shots。

## 核心逻辑

```
grid 已产出采样帧（时间戳 + JPEG）+ clip 字幕文本
  │
  ├─ 发给 VL_MODEL
  ├─ VL 返回几组起止时间
  └─ FFmpeg 切割保存为 shot 片段
```

## 待做

### 后端
- [ ] 新建 `server/services/shotSegmentation.ts`
  - 读取 grid 已产出的采样帧（时间戳 + JPEG）
  - 取出该 clip 时间范围内的字幕文本
  - 组装多模态 prompt（帧图片 + 字幕），调用 VL_MODEL
  - 解析 VL 返回的起止时间 → `ShotSegment[]`
  - FFmpeg 切割保存到 `clips/shots/`
- [ ] 路由 `POST /api/shots`

### 存储
```
clips/
├── shots/
│   ├── {clipId}_shot_{idx}.mp4
│   └── thumbnails/
│       └── {clipId}_shot_{idx}.jpg
```
- clips.json 的 GalleryClip 增加 `shots` 字段

### 前端
- [ ] ClipRow 加 "Detect Shots" 按钮（VL_MODEL 配置时才显示）
- [ ] 展开显示 shot 列表（缩略图 + 时长）

### QA
- [ ] VL 返回边界准确性
- [ ] 单一场景 clip 不被错误分割
- [ ] 无 VL_MODEL 时按钮不显示