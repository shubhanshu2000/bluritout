import asyncio
from typing import List, Tuple

import cv2
import numpy as np
from fastapi import FastAPI
import uvicorn
from pydantic import BaseModel


def main():
    print("Hello from be!")
    uvicorn.run(app, host="0.0.0.0", port=8080)


app = FastAPI()
cascade_classifier = cv2.CascadeClassifier

@app.get("/")
async def root():
    return {"msg": 'Hello Pyhton'}

if __name__ == "__main__":
    main()
