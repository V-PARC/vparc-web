"""끝-끝 시험용 판정 API 띄우기 (로컬, 임시 DB). 실제 판정기 대신 고정 확률 + 지연을 쓴다.

  VPARC_API_DIR=../vparc-api python3 e2e/run_api.py 8765 <임시폴더> [지연초]
"""
import json
import os
import sys
import time
from pathlib import Path

port, tmp = int(sys.argv[1]), Path(sys.argv[2])
delay = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
tmp.mkdir(parents=True, exist_ok=True)
os.environ.update(VPARC_DB_PATH=str(tmp / "vparc.sqlite3"), VPARC_PHOTO_DIR=str(tmp / "photos"),
                  VPARC_ADMIN_KEY="e2e-admin", VPARC_RATE_LIMIT="1000",
                  VPARC_DEBUG_LOG=str(tmp / "judge_debug.jsonl"),
                  VPARC_ALLOWED_ORIGINS=os.environ.get("E2E_ORIGIN", "http://127.0.0.1:8766"))
sys.path.insert(0, str(Path(os.environ["VPARC_API_DIR"]).resolve()))

import uvicorn  # noqa: E402
from app.db.session import connect, tx  # noqa: E402
from app.main import create_app  # noqa: E402
from app.ml import model as ml  # noqa: E402


class FixedModel:
    name = "e2e-fixed"

    def predict(self, image_bytes, box):
        time.sleep(delay)            # 실제 서버 판정 ≈2.7초 흉내
        return {"p_sufficient": 0.9, "p_fallen": 0.05, "p_tactile": 0.05, "p_entrance": 0.05,
                "p_walkway": 0.05, "p_location": 0.05}


app = create_app()
reco = json.loads((Path(__file__).resolve().parent.parent / "reco_data.json").read_text(encoding="utf-8"))
c = connect()
with tx(c):
    for z in reco["zones"]:
        c.execute("""INSERT OR IGNORE INTO zones(zone_id, name, region, lat, lon, status, data_version)
                     VALUES (?,?,?,?,?,'NO_ISSUE','e2e')""", (z["id"], z["id"], str(z["r"]), z["lat"], z["lon"]))
c.close()
from app.state import state  # noqa: E402
state.load()
ml.set_model(FixedModel())
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
