import shutil

from fastapi import APIRouter

router = APIRouter()


@router.get("/system-status")
async def system_status() -> dict:
    return {"wsl_available": shutil.which("wsl") is not None}
