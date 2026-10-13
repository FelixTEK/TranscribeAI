cd "D:/Documents/GitHub/TranscribeAI/data/eval"
python -m venv venv && ./venv/Scripts/python.exe -m pip install -q pyarrow numpy
curl -sL -o test.parquet "https://huggingface.co/datasets/google/fleurs/resolve/refs%2Fconvert%2Fparquet/th_th/test/0000.parquet"
ls -la test.parquet
./venv/Scripts/python.exe - <<'PY'
import pyarrow.parquet as pq
t = pq.read_table("test.parquet")
print(t.schema.names, t.num_rows)
PY
echo PREP_DONE
