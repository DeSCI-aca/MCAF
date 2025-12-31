// frontend/app.js 核心逻辑
import { nav, getRoute } from "./router.js";

let currentMode = "select"; // select | polygon
let polygonPoints = [];
let polygonCanvas = null;
let polygonCtx = null;
let lastMaskSource = null;



const labeledMasks = {};

window.nav = nav; // 暴露给 HTML 内部脚本

// ... 之前的 getRoute, nav 等保持不变 ...

async function render() {
  const route = getRoute();
  const appEl = document.getElementById("app");

  if (route === "/import") {
      await loadPage("./pages/import.html");
      if (typeof bindImportEvents === 'function') bindImportEvents(); 
  } 
  else if (route === "/image") {
      // 图像标注任务
      await loadPage("./pages/image.html");
      if (typeof bindImageAnnotationEvents === 'function') {
          bindImageAnnotationEvents(); // 这里会执行你刚拆解的 SAM 逻辑
      }
  } 
  else if (route === "/tracking-editor") {
    await loadPage("./pages/tracking_editor.html");
    if (typeof initTrackingEditor === "function") {
      initTrackingEditor();
    }
  }  
  else if (route === "/pointcloud") {
      renderTaskPage("点云标注");
  } 
  else {
      renderDashboard();
  }
}

async function loadPage(url) {
  const res = await fetch(url);
  const html = await res.text();
  app.innerHTML = html;

  // 修复：手动提取并运行 HTML 中的 script 标签
  const scripts = app.querySelectorAll("script");
  scripts.forEach(oldScript => {
      const newScript = document.createElement("script");
      newScript.textContent = oldScript.textContent;
      document.body.appendChild(newScript).parentNode.removeChild(newScript);
  });
}

async function renderDashboard() {
    const res = await fetch("/api/get-context");
    const state = await res.json();
    window.currentPath = state.project_path;

    document.getElementById("app").innerHTML = `
        <div class="dashboard">
            <header class="header-banner">
                <h1>标注平台架构 V1.0</h1>
                <div class="path-badge">${state.project_path || '未选择数据源'}</div>
            </header>
            <div class="task-grid">
                <div class="card" onclick="nav('/import')">
                    <h3>📂 数据导入</h3>
                    <p>校验并配置项目根目录</p>
                </div>
                <div class="card ${!state.project_path ? 'disabled' : ''}" onclick="nav('/image')">
                    <h3>🖼️ 图像分割</h3>
                    <p>支持 2D 语义分割与实例分割</p>
                </div>
                <div
                  class="card ${!state.project_path ? 'disabled' : ''}"
                  onclick="runTrackingExport()"
                >
                    <h3>🎯 2D Tracking 导出</h3>
                    <p>从 panoptic 结果生成 Tracking COCO</p>
                </div>
                <div 
                  class="card ${!state.project_path ? 'disabled' : ''}"
                  onclick="runPointCloudSeg()"
                >
                    <h3>☁️ 生成点云分割</h3>
                    <p>支持 3D 目标检测与语义标注</p>
                </div>
                <div class="card" onclick="runLidarOdometry()">
                  <h3>🧭 里程计生成</h3>
                  <p>基于语义点云进行 LiDAR Odometry</p>
                </div>
                <div class="card" onclick="location.href='/pages/pc.html'">
                  <h3>🛠 点云分割修正</h3>
                  <p>人工修正点云语义 / 实例 / 3D 框</p>
                </div>
                <div class="card ${!state.project_path ? 'disabled' : ''}"
                    onclick="runPointcloudReproject()">
                  <h3>🔁 点云回投 / 框还原</h3>
                  <p>将最后一帧标注还原到所有帧</p>
                </div>
            </div>
        </div>
    `;
}

window.addEventListener("hashchange", render);
window.onload = render;

// 绑定导入页面的逻辑
function bindImportEvents() {
  const btn = document.getElementById('btnVerify');
  const input = document.getElementById('pathInput');
  const result = document.getElementById('checkResult');

  if (!btn) return;

  btn.onclick = async () => {
      const path = input.value.trim();
      const res = await fetch('/api/import-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path })
      });
      
      const data = await res.json();
      if (res.ok) {
          result.innerHTML = `<div class="badge done">✓ 导入成功: ${data.path}</div>`;
          setTimeout(() => nav("/"), 1500); // 成功后 1.5 秒自动回首页
      } else {
          result.innerHTML = `<div class="badge error">✘ 错误: ${data.detail}</div>`;
      }
  };
}

// frontend/app.js 里的核心逻辑片段
async function bindImageAnnotationEvents() {
  const fileNameEl = document.getElementById('currentFileName');
  const baseImage = document.getElementById('baseImage');
  const segOverlay = document.getElementById('segOverlay');
  const btnPolygon = document.getElementById("btnPolygon");

  const polygonImage = document.getElementById("polygonImage");

  polygonCanvas = document.getElementById("polygonCanvas");
  if (!polygonCanvas) {
    console.warn("polygonCanvas not found");
    return;
  }
  
  polygonCtx = polygonCanvas.getContext("2d");

  polygonCanvas.addEventListener("click", (e) => {
    console.log("🔥 polygonCanvas clicked", e.clientX, e.clientY);
    if (currentMode !== "polygon") return;

    const rect = polygonCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * polygonCanvas.width / rect.width;
    const y = (e.clientY - rect.top) * polygonCanvas.height / rect.height;

    polygonPoints.push([Math.round(x), Math.round(y)]);
    redrawPolygon();
  });

  polygonCanvas.addEventListener("dblclick", (e) => {
    if (currentMode !== "polygon") return;
    e.preventDefault();   // 👈 很重要，防止 click 再触发一次
    finishPolygon();
  });



  if (!baseImage || !segOverlay) {
    console.error("Image DOM not ready");
    return;
  }

  // 初始模式
  setMode("select");

  document.getElementById("btnCursor").onclick = () => {
    setMode("select");
  };

  document.getElementById("btnPolygon").onclick = () => {
    setMode("polygon");
  };

  // ===== 1️⃣ 绑定点击事件（查 mask）=====
  baseImage.addEventListener("click", async (e) => {
      const rect = baseImage.getBoundingClientRect();
      const x = Math.floor(
        (e.clientX - rect.left) * baseImage.naturalWidth / rect.width
      );
      const y = Math.floor(
        (e.clientY - rect.top) * baseImage.naturalHeight / rect.height
      );
    
      // ===============================
      // 🖱️ 选择模式 → 查 SAM mask
      // ===============================
      if (currentMode === "select") {
        const res = await fetch("/api/image/query-mask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ x, y })
        });
    
        const data = await res.json();
        if (data.mask_id == null) {
          console.warn("❌ no mask");
          return;
        }
        lastMaskSource = "sam";
        showClassDialog(data.mask_id, data.class_options);
        return;
      }
    
      // ===============================
      // ⬢ 多边形模式 → 什么都不做（由 polygonCanvas 处理）
      // ===============================
      if (currentMode === "polygon") {
        console.log("polygon mode: ignore baseImage click");
        return;
      }
    });    

  // ===== 2️⃣ 加载第一张图 =====
  try {
    const res = await fetch('/api/image/init-first');
    if (!res.ok) throw new Error("Failed to load SAM results");

    const data = await res.json();

    fileNameEl.textContent = `当前文件: ${data.filename}`;
    baseImage.src = `data:image/png;base64,${data.ori_image}`;
    segOverlay.src = `data:image/png;base64,${data.seg_image}`;
    if (polygonImage) {
      polygonImage.onload = () => {
        initPolygonCanvas();
      };
      polygonImage.src = baseImage.src;
      
    } else {
      console.warn("polygonImage not found, polygon disabled");
    }
  } catch (err) {
    console.error(err);
    alert("加载失败，请检查后端日志和权重路径");
  }

  btnPolygon.onclick = () => {
    //showPolygonPanel();
    setMode("polygon");
  };

  const btnSaveNext = document.getElementById("btnSaveNext");
  if (!btnSaveNext) {
    console.warn("btnSaveNext not found");
    return;
  }

  btnSaveNext.onclick = async () => {
    const res = await fetch("/api/image/save-and-next", {
      method: "POST"
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.detail || "保存失败");
      return;
    }
    document.getElementById("baseImage").src =
      "data:image/png;base64," + data.ori_image;

    document.getElementById("segOverlay").src =
      "data:image/png;base64," + data.sam_overlay;
      
    document.getElementById("samResultImage").src =
      "data:image/png;base64," + data.matched_overlay;

    document.getElementById("polygonImage").src =
      "data:image/png;base64," + data.ori_image;
    
    document.getElementById("polygonResultImage").src =
      "data:image/png;base64," + data.polygon_overlay;

    // ⚠️ 清空旧帧所有标注
    Object.keys(labeledMasks).forEach(k => delete labeledMasks[k]);

    // 用后端给的 labels 重建
    data.labels.forEach(item => {
      labeledMasks[item.mask_id] = {
        class_id: item.class_id,
        class_name: item.class_name,
        instance_id: item.instance_id
      };
    });

    // 刷新右侧列表
    renderLabelList();


    console.log("✅ saved and next:", data);
  };

}

function showClassDialog(maskId, classOptions) {
  // 如果已经存在对话框，先移除
  const old = document.getElementById("class-dialog");
  if (old) old.remove();

  // 创建容器
  const dialog = document.createElement("div");
  dialog.id = "class-dialog";
  dialog.style.cssText = `
    position: fixed;
    top: 30%;
    left: 50%;
    transform: translateX(-50%);
    background: #1e1e1e;
    color: #fff;
    padding: 16px;
    border-radius: 8px;
    z-index: 9999;
    min-width: 260px;
    font-family: sans-serif;
    box-shadow: 0 0 12px rgba(0,0,0,0.5);
  `;

  // 构建下拉列表
  const optionsHtml = classOptions
    .map(c => `<option value="${c}">${c}</option>`)
    .join("");

  dialog.innerHTML = `
    <div style="margin-bottom: 8px; font-weight: bold;">
      选择类别（mask ${maskId}）
    </div>

    <select id="class-select" size="8"
      style="
        width: 100%;
        background: #2b2b2b;
        color: #fff;
        border: 1px solid #555;
        padding: 4px;
      ">
      ${optionsHtml}
    </select>

    <div style="margin-top: 10px; text-align: right;">
      <button id="class-ok" style="margin-right: 6px;">确定</button>
      <button id="class-cancel">取消</button>
    </div>
  `;

  document.body.appendChild(dialog);

  // 绑定按钮
  document.getElementById("class-ok").onclick = () => {
    const cls = document.getElementById("class-select").value;
    applyClass(maskId, cls);
    dialog.remove();
  };

  document.getElementById("class-cancel").onclick = () => {
    dialog.remove();
  };
}

// 在 app.js 中找个位置添加
function renderTaskPage(title) {
  const appEl = document.getElementById("app");
  appEl.innerHTML = `
      <div class="container">
          <nav style="margin-bottom: 20px;">
              <button class="btn" onclick="nav('/')">← 返回仪表盘</button>
          </nav>
          <div class="card">
              <h2>${title}</h2>
              <p>正在开发中...</p>
          </div>
      </div>
  `;
}

async function applyClass(maskId, className) {
  const res = await fetch("/api/image/set-mask-class", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mask_id: maskId,
      class_name: className
    })
  });

  const data = await res.json();
  if (!res.ok) {
    alert(data.detail || "设置失败");
    return;
  }

  if (data.sam_overlay) {
    updateResultImage(data.sam_overlay);
  }
  if (data.polygon_overlay) {
    updatePolygonResultImage(data.polygon_overlay);
  }
  // ===============================
  // ✅ 维护前端标注状态（第一步）
  // ===============================
  labeledMasks[maskId] = {
    class_id: data.class_id ?? null,
    class_name: className,
    instance_id: data.instance_id ?? null
  };

  renderLabelList();

  // ===============================
  // 情况 1：非 thing 类 → 直接完成
  // ===============================
  if (!data.need_instance) {
    //updateResultImage(data.overlay_image);
    //renderLabelList();   // ✅ 刷新右上角列表
    return;
  }

  // ===============================
  // 情况 2：thing 类 → 选实例
  // ===============================
  showInstanceDialog(data.existing_instances, async (choice) => {
    const res2 = await fetch("/api/image/set-mask-instance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mask_id: maskId,
        class_name: className,
        instance: choice
      })
    });

    const data2 = await res2.json();
    if (!res2.ok) {
      alert(data2.detail || "实例设置失败");
      return;
    }

    // ===============================
    // ✅ 更新 instance id
    // ===============================
    labeledMasks[maskId].instance_id = data2.instance_id;

    if (data2.sam_overlay) {
      updateResultImage(data2.sam_overlay);
    }
    if (data2.polygon_overlay) {
      updatePolygonResultImage(data2.polygon_overlay);
    }
    
    renderLabelList();   // ✅ 再次刷新列表
  });
}

function showInstanceDialog(existingInstances, onConfirm) {
  // 移除旧的
  const old = document.getElementById("instance-dialog");
  if (old) old.remove();

  const dialog = document.createElement("div");
  dialog.id = "instance-dialog";
  dialog.style.cssText = `
    position: fixed;
    top: 35%;
    left: 50%;
    transform: translateX(-50%);
    background: #1e1e1e;
    color: #fff;
    padding: 16px;
    border-radius: 8px;
    z-index: 10000;
    min-width: 260px;
    box-shadow: 0 0 12px rgba(0,0,0,0.5);
    font-family: sans-serif;
  `;

  const options = existingInstances
    .map(id => `<option value="${id}">${id}</option>`)
    .join("");

  dialog.innerHTML = `
    <div style="margin-bottom:8px;font-weight:bold;">
      选择实例 ID
    </div>

    <select id="instance-select" size="6"
      style="
        width:100%;
        background:#2b2b2b;
        color:#fff;
        border:1px solid #555;
        padding:4px;
      ">
      ${options}
      <option value="new">➕ new instance</option>
    </select>

    <div style="margin-top:10px;text-align:right;">
      <button id="instance-ok">确定</button>
      <button id="instance-cancel" style="margin-left:6px;">取消</button>
    </div>
  `;

  document.body.appendChild(dialog);

  document.getElementById("instance-ok").onclick = () => {
    const value = document.getElementById("instance-select").value;
    dialog.remove();
    onConfirm(value);
  };

  document.getElementById("instance-cancel").onclick = () => {
    dialog.remove();
  };
}


function updateResultImage(b64) {
  const img = document.getElementById("samResultImage");
  if (!img) {
    console.error("samResultImage not found in DOM");
    return;
  }

  img.src = `data:image/png;base64,${b64}`;
  img.style.display = "block";
}

function updatePolygonResultImage(b64) {
  const img = document.getElementById("polygonResultImage");
  if (!img) {
    console.error("polygonResultImage not found in DOM");
    return;
  }

  img.src = `data:image/png;base64,${b64}`;
  img.style.display = "block";
}


function renderLabelList() {
  const ul = document.getElementById("labelList");
  if (!ul) return;

  ul.innerHTML = "";

  Object.entries(labeledMasks).forEach(([maskId, info]) => {
    const li = document.createElement("li");

    li.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <b>mask ${maskId}</b><br/>
          class: ${info.class_id} (${info.class_name})<br/>
          inst: ${info.instance_id ?? "-"}
        </div>
        <button class="del-btn" title="删除">✖</button>
      </div>
    `;

    // ===== 绑定删除 =====
    li.querySelector(".del-btn").onclick = () => {
      deleteMask(maskId);
    };

    ul.appendChild(li);
  });
}

async function deleteMask(maskId) {
  const ok = confirm(`确定删除 mask ${maskId} 的标注？`);
  if (!ok) return;

  const res = await fetch("/api/image/delete-mask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mask_id: maskId })
  });

  const data = await res.json();
  if (!res.ok) {
    alert(data.detail || "删除失败");
    return;
  }

  // ===== 更新前端状态 =====
  delete labeledMasks[maskId];
  renderLabelList();

  // ===== 更新 overlay =====
  if (data.sam_overlay) {
    updateResultImage(data.sam_overlay);
  }
  if (data.polygon_overlay) {
    updatePolygonResultImage(data.polygon_overlay);
  }
  

  // ===== 更新右上角列表 =====
  renderLabelList();
}

// document.getElementById("btnPolygon").onclick = () => {
//   currentMode = "polygon";
//   showPolygonPanel();
// };

function showPolygonPanel() {
  const panel = document.getElementById("polygonPanel");
  panel.style.display = "block";

  const canvas = document.getElementById("polygonCanvas");
  const img = document.getElementById("baseImage");

  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  canvas.style.width = "300px";
  canvas.style.height = `${300 * img.naturalHeight / img.naturalWidth}px`;

  polygonPoints = [];

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
}

function redrawPolygon(close = false) {
  if (!polygonCtx || !polygonCanvas) return;

  if (polygonCtx && polygonCanvas) {
    polygonCtx.clearRect(0, 0, polygonCanvas.width, polygonCanvas.height);
  }

  if (polygonPoints.length === 0) return;

  // 画线
  polygonCtx.strokeStyle = "#22c55e";
  polygonCtx.lineWidth = 2;
  polygonCtx.beginPath();

  polygonPoints.forEach(([x, y], i) => {
    if (i === 0) polygonCtx.moveTo(x, y);
    else polygonCtx.lineTo(x, y);
  });

  if (close) {
    polygonCtx.lineTo(polygonPoints[0][0], polygonPoints[0][1]);
  }

  polygonCtx.stroke();

  // 画点
  polygonCtx.fillStyle = "#22c55e";
  polygonPoints.forEach(([x, y]) => {
    polygonCtx.beginPath();
    polygonCtx.arc(x, y, 4, 0, Math.PI * 2);
    polygonCtx.fill();
  });
}

async function finishPolygon() {
  if (polygonPoints.length < 3) {
    alert("至少需要 3 个点");
    return;
  }

  // 视觉闭环
  redrawPolygon(true);

  const res = await fetch("/api/image/polygon-create-mask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      polygon_points: polygonPoints
    })
  });

  const data = await res.json();
  if (!res.ok) {
    alert("Polygon mask 创建失败");
    return;
  }

  // ✅ 立刻清空绘制区，准备下一个
  polygonPoints = [];
  if (polygonCtx && polygonCanvas) {
    polygonCtx.clearRect(0, 0, polygonCanvas.width, polygonCanvas.height);
  }

  // ✅ 和 SAM 一样：弹类别 / 实例
  lastMaskSource = "polygon";
  showClassDialog(data.mask_id, data.class_options);
}

function initPolygonCanvas() {
  const polygonImg = document.getElementById("polygonImage");
  const polygonCanvas = document.getElementById("polygonCanvas");

  const rect = polygonImg.getBoundingClientRect();

  polygonCanvas.width  = polygonImg.naturalWidth;
  polygonCanvas.height = polygonImg.naturalHeight;

  polygonCanvas.style.width  = rect.width + "px";
  polygonCanvas.style.height = rect.height + "px";

  console.log(
    "✅ polygon canvas ready:",
    polygonCanvas.width,
    polygonCanvas.height,
    "display:",
    rect.width,
    rect.height
  );
}

function setMode(mode) {
  currentMode = mode;

  const btnCursor = document.getElementById("btnCursor");
  const btnPolygon = document.getElementById("btnPolygon");

  btnCursor.classList.toggle("active", mode === "select");
  btnPolygon.classList.toggle("active", mode === "polygon");

  // ✅ 永远显示 polygonPanel
  const polygonPanel = document.getElementById("polygonPanel");
  if (polygonPanel) {
    polygonPanel.style.display = "block";
  }

  // ✅ 只控制是否响应鼠标
  if (polygonCanvas) {
    polygonCanvas.style.pointerEvents =
      mode === "polygon" ? "auto" : "none";
  }

  console.log("🔧 mode switched to:", mode);
}

async function runTrackingExport() {
  if (!confirm("将从 panoptic 结果生成 2D Tracking 数据，是否继续？")) {
    return;
  }

  try {
    const res = await fetch("/api/tracking/generate", {
      method: "POST"
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.detail || "Tracking 生成失败");
      return;
    }

    alert(
      `✅ Tracking 生成完成\n\n` +
      `输出文件：${data.output}\n` +
      `图像数量：${data.num_images}`
    );
    nav("/tracking-editor");
  } catch (e) {
    console.error(e);
    alert("请求失败，请检查后端日志");
  }
}
window.runTrackingExport = runTrackingExport;

// pc.js
async function runPointCloudSeg() {
  const ok = confirm("将使用 panoptic 结果生成 3D 点云标注，是否继续？");
  if (!ok) return;

  const res = await fetch("/api/pointcloud/run", { method: "POST" });
  const data = await res.json();

  alert("✅ 点云分割完成\nFrames: " + data.frames);
}
window.runPointCloudSeg = runPointCloudSeg;

async function runLidarOdometry() {
  if (!confirm("将运行 LiDAR 里程计并生成全局地图，是否继续？")) {
    return;
  }

  try {
    const res = await fetch("/api/pointcloud/odometry", {
      method: "POST"
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.detail || "里程计生成失败");
      return;
    }

    alert(
      "✅ 里程计生成完成\n\n" +
      `帧数: ${data.frames}\n` +
      `输出目录:\n${data.output_dir}`
    );
  } catch (e) {
    console.error(e);
    alert("请求失败，请检查后端日志");
  }
}
window.runLidarOdometry = runLidarOdometry;

async function runPointcloudReproject() {
  if (!confirm("将执行点云回投与 3D 框还原，是否继续？")) return;

  try {
    const res = await fetch("/api/pointcloud/reproject", {
      method: "POST"
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.detail || "执行失败");
      return;
    }

    alert(
      `✅ 回投完成\n\n` +
      `Frames: ${data.frames}\n` +
      `Boxes: ${data.boxes_dir}\n` +
      `Points: ${data.points_dir}`
    );
  } catch (e) {
    console.error(e);
    alert("请求失败，请查看后端日志");
  }
}
window.runPointcloudReproject = runPointcloudReproject;
