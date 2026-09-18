"""The glyphs router, end to end through the real app.

Goes through `create_app` rather than poking the router directly, because the thing
most likely to break here is registration against the FROZEN app.py — and that is
exactly what a direct-import test would skip.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from assignment_helper.app import ServerConfig, create_app
from assignment_helper.security import SessionToken
from support import synthetic_sheet as synth


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    token = SessionToken()
    port = 7420
    app = create_app(ServerConfig(port=port), token)
    # base_url matters: the frozen security.py pins the Host header to 127.0.0.1 or
    # localhost as its DNS-rebinding defence, and TestClient otherwise sends
    # "testserver", which is correctly rejected with a 403.
    with TestClient(app, base_url=f"http://127.0.0.1:{port}") as test_client:
        test_client.headers.update({"x-ah-token": token.value})
        yield test_client


def test_the_router_reports_itself_implemented(client) -> None:
    response = client.get("/api/glyphs/health")
    assert response.status_code == 200
    assert response.json() == {"router": "glyphs", "implemented": True}


def test_status_shows_glyphs_as_implemented(client) -> None:
    """The frozen app.py builds this map from each router's IMPLEMENTED flag."""
    assert client.get("/api/status").json()["routers"]["glyphs"] is True


def test_the_sheet_endpoint_writes_a_pdf(client, tmp_path) -> None:
    destination = tmp_path / "sheet.pdf"
    response = client.post("/api/glyphs/sheet", json={"destination": str(destination)})

    assert response.status_code == 200
    body = response.json()
    assert body["pages"] == 4
    assert body["cellsPerPage"] == 90
    # The unverified premise is surfaced to the caller, not buried in a docstring.
    assert body["colourDropVerifiedOnPaper"] is False

    assert destination.is_file()
    assert destination.read_bytes().startswith(b"%PDF")


def test_a_bad_profile_name_is_refused_by_name(client) -> None:
    response = client.post(
        "/api/glyphs/extract/begin", json={"profile_id": "../../escape"}
    )
    assert response.status_code == 507
    assert response.json()["detail"]["code"] == "glyphs.profile-write"


def test_running_a_job_with_no_photos_is_refused(client) -> None:
    job = client.post("/api/glyphs/extract/begin", json={"profile_id": "empty"}).json()
    response = client.post(f"/api/glyphs/extract/run/{job['jobId']}")
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "glyphs.no-photos"


def test_an_unknown_job_is_a_named_404(client) -> None:
    response = client.get("/api/glyphs/progress/deadbeef")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "glyphs.unknown-job"


def test_a_full_extraction_through_the_router(client, tmp_path) -> None:
    """begin -> page -> run -> poll -> the profile is on disk and listable."""
    job = client.post(
        "/api/glyphs/extract/begin", json={"profile_id": "router-hand"}
    ).json()
    job_id = job["jobId"]

    image, _truth = synth.render_filled_page(0)
    photo = synth.encode_png(synth.photograph(image, scale=0.55))
    upload = client.post(
        f"/api/glyphs/extract/page/{job_id}",
        content=photo,
        headers={"content-type": "application/octet-stream"},
    )
    assert upload.status_code == 200
    assert upload.json()["pagesReceived"] == 1

    assert client.post(f"/api/glyphs/extract/run/{job_id}").status_code == 200

    deadline = time.monotonic() + 120
    state = "running"
    while time.monotonic() < deadline:
        body = client.get(f"/api/glyphs/progress/{job_id}").json()
        state = body["state"]
        if state in {"done", "failed"}:
            break
        time.sleep(0.2)

    assert state == "done", f"extraction did not finish: {body}"
    result = body["result"]
    assert result["status"] == "complete"
    assert result["coverage"]["covered"] == 90
    assert result["timings"]["totalSeconds"] > 0

    assert client.get("/api/glyphs/profiles").json()["profiles"] == ["router-hand"]

    summary = client.get("/api/glyphs/profile/router-hand").json()
    assert summary["unitsPerEm"] == 1000
    assert summary["extraction"]["colourDropVerifiedOnPaper"] is False
    # The outlines are the user's handwriting and must NOT come back over the wire (I9).
    assert "glyphs" not in summary


def test_a_missing_profile_is_a_named_error(client) -> None:
    response = client.get("/api/glyphs/profile/nope")
    assert response.status_code == 507
    assert response.json()["detail"]["code"] == "glyphs.profile-write"


def test_a_hard_failure_surfaces_as_a_named_problem_and_writes_nothing(
    client, tmp_path
) -> None:
    """Acceptance row 4, through the HTTP surface."""
    job = client.post(
        "/api/glyphs/extract/begin", json={"profile_id": "three-markers"}
    ).json()
    job_id = job["jobId"]

    photo = synth.encode_png(
        synth.photograph(synth.blank_marker_page(0, keep=3), scale=0.55)
    )
    client.post(
        f"/api/glyphs/extract/page/{job_id}",
        content=photo,
        headers={"content-type": "application/octet-stream"},
    )
    client.post(f"/api/glyphs/extract/run/{job_id}")

    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        body = client.get(f"/api/glyphs/progress/{job_id}").json()
        if body["state"] in {"done", "failed"}:
            break
        time.sleep(0.2)

    assert body["state"] == "failed"
    assert body["problem"]["code"] == "glyphs.markers-not-found"
    assert body["problem"]["missing"]
    assert not list(tmp_path.rglob("glyphs.json"))
