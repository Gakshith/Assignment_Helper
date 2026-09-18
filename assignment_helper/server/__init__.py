"""The server strand: CLI, HTTP, WS, file watch, session store.

Owns nothing above it. Reaches other modules only through their routers.
I17: nothing here may import cv2, skimage, skan, numba or numpy.
"""
