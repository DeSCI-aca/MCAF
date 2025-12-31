# backend/scripts/pointcloud_reproject.py
import numpy as np
import os
import json

def run_pointcloud_reproject(project_path):
    base = os.path.join(project_path)

    poses = np.load(os.path.join(base, "lidar_odometry/lidar_poses.npy"))
    boxes_last = load_kitti_boxes(
        os.path.join(base, "lidar_odometry/000000.txt")
    )

    # ---------- 1. 生成每帧 box ----------
    out_box_dir = os.path.join(base, "DDD_boxes")
    os.makedirs(out_box_dir, exist_ok=True)

    all_boxes = generate_boxes_per_frame(boxes_last, poses)
    for i, boxes_i in enumerate(all_boxes):
        save_kitti_boxes(
            boxes_i,
            os.path.join(out_box_dir, f"frame_{i:06d}.txt")
        )

    # ---------- 2. 还原点云并写 JSON ----------
    global_npy = os.path.join(base, "lidar_odometry/global_map_with_meta.npy")
    out_pc_dir = os.path.join(base, "pointcloud_segmentation_revised")
    os.makedirs(out_pc_dir, exist_ok=True)

    data = np.load(global_npy)
    xyz = data[:, :3]
    frame_ids = data[:, 6].astype(int)
    cat = data[:, 7].astype(int)
    inst = data[:, 8].astype(int)

    T_last = poses[-1]
    num_frames = poses.shape[0]

    for i in range(num_frames):
        mask = frame_ids == i
        if not mask.any():
            continue

        pts_last = xyz[mask]
        pts_h = np.hstack([pts_last, np.ones((len(pts_last), 1))])

        T = np.linalg.inv(poses[i]) @ T_last
        pts_i = (T @ pts_h.T).T[:, :3]

        out = {
            "xyz": pts_i.tolist(),
            "cat": cat[mask].tolist(),
            "inst": inst[mask].tolist()
        }

        with open(
            os.path.join(out_pc_dir, f"frame_{i:03d}.json"),
            "w"
        ) as f:
            json.dump(out, f)

    return {
        "boxes_dir": out_box_dir,
        "points_dir": out_pc_dir,
        "frames": num_frames
    }


# ======================
# 以下：你原来的函数，原封不动
# ======================
def load_kitti_boxes(txt_path):
    boxes = []
    with open(txt_path) as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) < 8:
                continue
            _, x, y, z, l, w, h, yaw = parts
            boxes.append({
                "center": np.array([float(x), float(y), float(z)]),
                "size": (float(l), float(w), float(h)),
                "yaw": float(yaw)
            })
    return boxes

def transform_box(box, T):
    c_h = np.hstack([box["center"], 1.0])
    c_new = (T @ c_h)[:3]
    R = T[:3, :3]

    dir_vec = np.array([
        np.cos(box["yaw"]),
        np.sin(box["yaw"]),
        0.0
    ])
    dir_new = R @ dir_vec
    yaw_new = np.arctan2(dir_new[1], dir_new[0])

    return {
        "center": c_new,
        "size": box["size"],
        "yaw": yaw_new
    }

def box_last_to_frame_i(box, poses, i):
    T = np.linalg.inv(poses[i]) @ poses[-1]
    return transform_box(box, T)

def generate_boxes_per_frame(boxes_last, poses):
    return [
        [box_last_to_frame_i(b, poses, i) for b in boxes_last]
        for i in range(len(poses))
    ]

def save_kitti_boxes(boxes, path):
    with open(path, "w") as f:
        for b in boxes:
            x, y, z = b["center"]
            l, w, h = b["size"]
            yaw = b["yaw"]
            f.write(
                f"Unknown {x:.3f} {y:.3f} {z:.3f} "
                f"{l:.3f} {w:.3f} {h:.3f} {yaw:.6f}\n"
            )
