#!/bin/bash

# Test YouTube video URL (a short video with subtitles)
# Using a popular TED talk as example
VIDEO_URL="https://www.youtube.com/watch?v=UF8uR6Z6KLc"

echo "Testing /api/analyze endpoint..."
echo "Video URL: $VIDEO_URL"
echo ""

curl -X POST http://localhost:3001/api/analyze \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$VIDEO_URL\"}" \
  -w "\n\nHTTP Status: %{http_code}\n"
