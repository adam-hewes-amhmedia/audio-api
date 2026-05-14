import logging
import os
import structlog

REDACT_KEYS = {"token", "password", "authorization", "secret_key", "access_key"}

def _redactor(_logger, _name, event_dict):
    for k in list(event_dict.keys()):
        if k.lower() in REDACT_KEYS:
            event_dict[k] = "[REDACTED]"
    return event_dict

def setup(service: str) -> structlog.BoundLogger:
    level = os.environ.get("LOG_LEVEL", "info").upper()
    logging.basicConfig(level=level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _redactor,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level)),
    )
    return structlog.get_logger().bind(
        service=service,
        version=os.environ.get("SERVICE_VERSION", "dev"),
    )
