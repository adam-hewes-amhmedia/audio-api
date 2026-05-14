import os
import boto3

BUCKET = os.environ.get("OBJECT_STORE_BUCKET", "audio-api")

def client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["OBJECT_STORE_ENDPOINT"],
        aws_access_key_id=os.environ["OBJECT_STORE_ACCESS_KEY"],
        aws_secret_access_key=os.environ["OBJECT_STORE_SECRET_KEY"],
        region_name=os.environ.get("OBJECT_STORE_REGION", "us-east-1"),
    )

def download_to_file(s3, key: str, dest_path: str) -> None:
    s3.download_file(BUCKET, key, dest_path)

def upload_bytes(s3, key: str, data: bytes, content_type: str = "application/json") -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type)
