#!/bin/bash
# usage: run.sh <outdir> <model-file> [whisper flags...]
R="D:/Documents/GitHub/TranscribeAI"; E="$R/data/eval"
out=$1; model=$2; shift 2
rm -rf "$E/$out"; mkdir -p "$E/$out"; cp "$E"/w16/*.wav "$E/$out/"
cd "$E/$out"
start=$(date +%s)
"$R/bin/whisper/Release/whisper-cli.exe" -m "$R/models/$model" -l th -mc 0 -np -oj "$@" *.wav > "$E/$out.log" 2>&1
echo "$out: $(( $(date +%s)-start ))s"
