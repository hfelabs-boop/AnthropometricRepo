import numpy as np

def load(tag):
    """Unposed (arms-out) mesh of body `tag` ("M"/"F") centred on x=0 with the feet on z=0; returns vertices, triangles, height."""
    z = np.load(f"out/{tag}.npz"); U = z["V"].astype(float); T = z["T"]
    off = np.array([U[:, 0].mean(), 0, U[:, 2].min()]); U = U - off
    return U, T, U[:, 2].max()
