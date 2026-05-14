import json
from py_common.logging_setup import setup

def test_redacts_token(capsys):
    log = setup("test")
    log.info("hi", token="secret123", path="/x")
    captured = capsys.readouterr().out
    assert "secret123" not in captured
    assert "[REDACTED]" in captured
