"""
Section 23: /api/sf/* and /signed-* storage endpoints.

The shared filesystem only exists where a bucket is configured; client-hosted
heads (remote-dev included) have none by default, so these run on local-dev,
whose nodes bind-mount a local dir under the same config key.
"""

from __future__ import annotations

import pytest

pytestmark = [pytest.mark.service, pytest.mark.local_dev]


def test_filemanager_unsupported_action_returns_400_body(main_http_client, local_dev_cluster):
    resp = main_http_client.post(
        "/api/sf/filemanager",
        json={"action": "totally-bogus-action", "path": "/"},
    )
    assert resp.status_code == 200  # Syncfusion wants 200 with an error body
    body = resp.json()
    assert body.get("error", {}).get("code") == "400"


def test_signed_download_404_on_missing(main_http_client, local_dev_cluster):
    resp = main_http_client.get("/signed-download?object_name=definitely-does-not-exist-xyz.txt")
    assert resp.status_code == 404


def test_signed_download_sanitizes_dot_dot(main_http_client, local_dev_cluster):
    resp = main_http_client.get("/signed-download?object_name=../../etc/passwd")
    # Either rejects path or returns 404 after sanitization.
    assert resp.status_code in (400, 404)


def test_batch_download_ticket_rejects_empty_items(main_http_client, local_dev_cluster):
    resp = main_http_client.post(
        "/batch-download-ticket",
        json={"items": [], "archiveName": "test.zip"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "No files provided for download"
