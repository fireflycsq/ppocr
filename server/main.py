#!/usr/bin/env python3
"""PaddleOCR-VL 离线识别 API（基于本地模型调研）"""

import os
import ssl
import urllib3
import time
import json
import base64
import traceback
import uuid
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import JSONResponse
import cv2
import numpy as np
from PIL import Image
from pprint import pprint
import io
import threading
from pdf2image import convert_from_path
# 禁用 SSL
urllib3.disable_warnings()
ssl._create_default_https_context = ssl._create_unverified_context
os.environ['REQUESTS_CA_BUNDLE'] = ''

# 初始化 FastAPI 应用
app = FastAPI(
    title="PaddleOCR-VL 离线识别 API",
    version="1.0.0",
    description="基于本地预训练模型的离线 OCR API，支持完全本地化部署"
)

# 全局变量
ocr_pipeline = None
ocr_model_loading = False
ocr_model_load_error: Optional[str] = None
TEMP_DIR = Path(os.environ.get("OCR_TEMP_DIR", "./temp_uploads"))
OUTPUT_DIR = Path(os.environ.get("OCR_OUTPUT_DIR", "./output"))
MODELS_DIR = Path(os.environ.get("OCR_MODELS_DIR", "./paddleocr_models"))


def _ensure_writable_dir(path: Path, label: str) -> None:
    """确保可写目录存在；模型目录只读挂载时不创建。"""
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RuntimeError(
            f"无法创建 {label} 目录 ({path}): {exc}. "
            f"请确认 Docker 已挂载可写卷，或宿主机已执行: mkdir -p data/temp_uploads data/output"
        ) from exc


_ensure_writable_dir(TEMP_DIR, "temp_uploads")
_ensure_writable_dir(OUTPUT_DIR, "output")
if not MODELS_DIR.is_dir():
    raise RuntimeError(
        f"模型目录不存在: {MODELS_DIR}. "
        f"请将 paddleocr_models 挂载到容器 /models（环境变量 OCR_MODELS_DIR）。"
    )


class Timer:
    """计时器类"""
    
    def __init__(self, name=""):
        self.name = name
        self.start_time = None
        self.end_time = None
    
    def __enter__(self):
        self.start_time = time.time()
        return self
    
    def __exit__(self, *args):
        self.end_time = time.time()
    
    @property
    def elapsed(self):
        if self.start_time and self.end_time:
            return self.end_time - self.start_time
        return 0
    
    @property
    def elapsed_str(self):
        elapsed = self.elapsed
        if elapsed < 1:
            return f"{elapsed*1000:.0f}ms"
        elif elapsed < 60:
            return f"{elapsed:.2f}s"
        else:
            minutes = int(elapsed // 60)
            seconds = elapsed % 60
            return f"{minutes}m {seconds:.2f}s"


class OfflineModelInvestigator:
    """离线模型调研类"""
    
    @staticmethod
    def check_local_models() -> Dict[str, Any]:
        """检查本地模型文件"""
        print("[模型检查] 扫描本地模型目录...")
        
        models_info = {
            "vl_rec": {
                "path": MODELS_DIR / "vl_rec",
                "description": "Vision-Language 识别模型",
                "exists": False,
                "files": []
            },
            "layout_det": {
                "path": MODELS_DIR / "layout_det",
                "description": "布局检测模型",
                "exists": False,
                "files": []
            },
            "doc_orientation": {
                "path": MODELS_DIR / "doc_orientation",
                "description": "文档方向分类模型",
                "exists": False,
                "files": []
            }
        }
        
        for model_name, model_info in models_info.items():
            model_path = model_info["path"]
            
            if model_path.exists():
                model_info["exists"] = True
                # 列出模型目录下的文件
                try:
                    model_files = list(model_path.rglob("*"))
                    model_info["files"] = [
                        {
                            "name": str(f.relative_to(model_path)),
                            "size": f.stat().st_size if f.is_file() else 0,
                            "is_file": f.is_file()
                        }
                        for f in model_files
                    ]
                    print(f"  ✓ {model_name}: 已找到 {len(model_info['files'])} 个文件")
                except Exception as e:
                    print(f"  ⚠ {model_name}: 扫描失败 - {e}")
            else:
                print(f"  ✗ {model_name}: 未找到模型文件")
        
        return models_info
    
    @staticmethod
    def get_model_info() -> Dict[str, Any]:
        """获取模型详细信息"""
        print("\n[模型信息] 收集模型配置信息...\n")
        
        model_info = {
            "vl_rec": {
                "type": "Vision-Language Recognition",
                "purpose": "多任务的 OCR 识别和理解",
                "capabilities": [
                    "文本识别",
                    "数学公式识别",
                    "表格识别",
                    "图表识别",
                    "视觉理解"
                ],
                "input": "图像",
                "output": "文本、坐标、置信度"
            },
            "layout_det": {
                "type": "Document Layout Detection",
                "purpose": "检测文档中的不同内容区域",
                "capabilities": [
                    "文本块检测",
                    "表格检测",
                    "图像检测",
                    "标题检测",
                    "列表检测"
                ],
                "input": "文档图像",
                "output": "区域坐标、区域类型"
            },
            "doc_orientation": {
                "type": "Document Orientation Classification",
                "purpose": "检测和分类文档的方向",
                "capabilities": [
                    "0° 方向检测",
                    "90° 旋转检测",
                    "180° 旋转检测",
                    "270° 旋转检测"
                ],
                "input": "文档图像",
                "output": "方向角度、置信度"
            }
        }
        
        for name, info in model_info.items():
            print(f"【{name}】")
            print(f"  类型: {info['type']}")
            print(f"  功能: {info['purpose']}")
            print(f"  能力:")
            for cap in info['capabilities']:
                print(f"    - {cap}")
            print()
        
        return model_info
    
    @staticmethod
    def investigate_model_performance() -> Dict[str, Any]:
        """调研模型性能参数"""
        print("[性能参数] 模型性能规格:\n")
        
        performance_info = {
            "vl_rec": {
                "model_size": "≈500MB-1GB",
                "inference_speed": "1-3s per image (CPU)",
                "accuracy": "95%+ 对常见文本",
                "supported_languages": ["Chinese", "English", "Multi-lingual"],
                "optimal_image_size": "1024x768 ~ 2048x1536",
                "min_text_size": "8px (depends on quality)"
            },
            "layout_det": {
                "model_size": "≈200-300MB",
                "inference_speed": "0.5-1.5s per image (CPU)",
                "accuracy": "90%+ 对常见布局",
                "supported_layouts": ["Text", "Table", "Image", "Title", "List"],
                "optimal_image_size": "1024x768 ~ 2048x1536"
            },
            "doc_orientation": {
                "model_size": "≈50-100MB",
                "inference_speed": "0.1-0.3s per image (CPU)",
                "accuracy": "98%+ 对标准文档",
                "supported_angles": [0, 90, 180, 270]
            }
        }
        
        for name, perf in performance_info.items():
            print(f"【{name}】")
            for key, value in perf.items():
                if isinstance(value, list):
                    print(f"  {key}: {', '.join(map(str, value))}")
                else:
                    print(f"  {key}: {value}")
            print()
        
        return performance_info


def init_offline_pipeline():
    """初始化离线识别管道"""
    global ocr_pipeline
    
    print("="*70)
    print("PaddleOCR-VL 离线识别模型初始化")
    print("="*70)
    print()
    
    # 步骤 1: 检查本地模型
    with Timer() as timer:
        investigator = OfflineModelInvestigator()
        models_status = investigator.check_local_models()
    print(f"  耗时: {timer.elapsed_str}\n")
    
    # 步骤 2: 获取模型信息
    model_info = investigator.get_model_info()
    
    # 步骤 3: 调研模型性能
    performance_info = investigator.investigate_model_performance()
    
    # 步骤 4: 初始化管道
    print("[初始化] 加载离线模型到内存（可能需要 5–20 分钟）...\n", flush=True)
    
    try:
        from paddleocr._pipelines.paddleocr_vl import PaddleOCRVL
        
        with Timer() as timer:
            ocr_pipeline = PaddleOCRVL(
                device="cpu",
                pipeline_version='v1.6',
                
                # 本地模型路径
                vl_rec_model_dir=str(MODELS_DIR / "vl_rec"),
                layout_detection_model_dir=str(MODELS_DIR / "layout_det"),
                doc_orientation_classify_model_dir=str(MODELS_DIR / "doc_orientation"),
                
                # 启用功能
                use_layout_detection=True,
                use_doc_orientation_classify=True,
                use_doc_unwarping=False,
                use_chart_recognition=False,
                use_seal_recognition=False,
                use_ocr_for_image_block=True,
                format_block_content=True,
                merge_layout_blocks=True,
            )
        
        print(f"  ✓ 模型加载完成，耗时: {timer.elapsed_str}\n", flush=True)
        
        return {
            "status": "success",
            "models_status": models_status,
            "model_info": model_info,
            "performance_info": performance_info,
            "initialization_time": timer.elapsed
        }
        
    except Exception as e:
        print(f"  ✗ 模型加载失败: {e}\n")
        traceback.print_exc()
        return {
            "status": "failed",
            "error": str(e)
        }


def extract_ocr_result(ocr_output) -> Dict[str, Any]:
    """
    提取基于全新 PaddleOCR-VL 架构的文档解析结果
    支持直接读取自定义类属性（.content, .label, .bbox）与常规字典
    """
    text_blocks = []
    extracted_text_list = []
    
    try:
        # 如果返回的是列表（通常说明传入的是多页 PDF，每页是一个字典结果）
        if isinstance(ocr_output, list):
            for page_data in ocr_output:
                sub_res = extract_ocr_result(page_data)
                text_blocks.extend(sub_res['blocks'])
                if sub_res['extracted_text']:
                    extracted_text_list.append(sub_res['extracted_text'])
            
            return {
                "blocks": text_blocks,
                "total_blocks": len(text_blocks),
                "extracted_text": "\n\n".join(extracted_text_list)
            }

        # 处理单页字典数据
        if isinstance(ocr_output, dict):
            if 'parsing_res_list' in ocr_output and isinstance(ocr_output['parsing_res_list'], list):
                for block in ocr_output['parsing_res_list']:
                    if block is None:
                        continue
                    
                    content = ""
                    label = "text"
                    bbox = []
                    block_order = None

                    # 核心改动：兼顾自定义类对象属性访问与普通字典访问
                    if isinstance(block, dict):
                        # 如果是字典
                        content = block.get('content', '') or block.get('block_content', '') or block.get('text', '')
                        label = block.get('label', '') or block.get('block_label', 'text')
                        bbox = block.get('bbox', [])
                        block_order = block.get('block_order', None)
                    else:
                        # 如果是 PaddleOCR 的类对象（支持 .content, .label, .bbox）
                        content = getattr(block, 'content', '') or getattr(block, 'block_content', '')
                        label = getattr(block, 'label', 'text') or getattr(block, 'block_label', 'text')
                        bbox = getattr(block, 'bbox', [])
                        block_order = getattr(block, 'block_order', None)

                    # 清洗文本数据，去除前后多余空格或换行
                    if content:
                        content = str(content).strip()

                    block_data = {
                        'text': content,
                        'layout_type': str(label).strip(),
                        'bbox': bbox,
                        'block_order': block_order
                    }
                    text_blocks.append(block_data)
                    
                    if content:
                        extracted_text_list.append(content)

    except Exception as e:
        print(f"  ⚠ 解析新版结构化结果失败: {e}")
        text_blocks = [{'text': f'解析失败: {str(e)}', 'error': True}]
        extracted_text_list = []
        
    if not text_blocks:
        text_blocks = [{'text': '未提取到有效文本块'}]
        extracted_text_list = ['[未提取到有效文本]']

    return {
        "blocks": text_blocks,
        "total_blocks": len(text_blocks),
        # 使用双换行连接段落，保持段落排版整洁
        "extracted_text": "\n\n".join(extracted_text_list)
    }


def encode_image_base64(image: np.ndarray, quality: int = 85) -> str:
    _, buf = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf).decode('ascii')


def make_thumbnail(image: np.ndarray, max_width: int = 160) -> np.ndarray:
    height, width = image.shape[:2]
    if width <= max_width:
        return image
    scale = max_width / width
    return cv2.resize(
        image,
        (max_width, int(height * scale)),
        interpolation=cv2.INTER_AREA,
    )


def recognize_image(image_path: str, task_id: str = None) -> Dict[str, Any]:
    """
    离线识别单个图像
    
    Args:
        image_path: 图像文件路径
        task_id: 任务ID
        
    Returns:
        识别结果字典
    """
    global ocr_pipeline
    
    if ocr_pipeline is None:
        raise RuntimeError("OCR 管道未初始化")
    
    task_id = task_id or str(uuid.uuid4())
    
    is_pdf = image_path.lower().endswith('.pdf')
    temp_jpg_paths: List[str] = []

    try:
        if is_pdf:
            print(f"  ↳ 检测到 PDF 文件，正在转换页面为图片...")
            pil_pages = convert_from_path(image_path, dpi=200)
            if not pil_pages:
                raise ValueError("PDF 转换为图片失败，文件可能损坏或为空")

            page_results = []
            total_blocks = 0
            total_ocr_time = 0.0

            for idx, pil_img in enumerate(pil_pages):
                print(f"  ↳ 识别第 {idx + 1}/{len(pil_pages)} 页...", end="", flush=True)
                image = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
                temp_jpg_path = f"{image_path}_page{idx}.jpg"
                cv2.imwrite(temp_jpg_path, image)
                temp_jpg_paths.append(temp_jpg_path)

                with Timer() as ocr_timer:
                    ocr_output = ocr_pipeline.predict(input=temp_jpg_path)
                result_data = extract_ocr_result(ocr_output)
                total_blocks += result_data["total_blocks"]
                total_ocr_time += ocr_timer.elapsed
                print(f" {ocr_timer.elapsed_str}, {result_data['total_blocks']} 块")

                page_results.append({
                    "page_index": idx,
                    "image_shape": {
                        "height": image.shape[0],
                        "width": image.shape[1],
                        "channels": image.shape[2] if len(image.shape) > 2 else 1,
                    },
                    "preview_image_base64": encode_image_base64(image),
                    "thumbnail_base64": encode_image_base64(make_thumbnail(image), quality=75),
                    "preview_image_mime": "image/jpeg",
                    "recognition_result": result_data,
                })

            extracted_parts = []
            for page in page_results:
                page_text = page["recognition_result"].get("extracted_text", "")
                if page_text:
                    extracted_parts.append(
                        f"--- 第 {page['page_index'] + 1} 页 ---\n{page_text}"
                    )

            first_page = page_results[0]
            return {
                "success": True,
                "task_id": task_id,
                "image_path": image_path,
                "is_pdf": True,
                "page_count": len(page_results),
                "pages": page_results,
                "image_shape": first_page["image_shape"],
                "recognition_result": {
                    "blocks": [],
                    "total_blocks": total_blocks,
                    "extracted_text": "\n\n".join(extracted_parts),
                },
                "timing": {
                    "document_orientation_detection": 0,
                    "ocr_recognition": total_ocr_time,
                    "result_extraction": 0,
                    "total": total_ocr_time,
                },
                "timestamp": datetime.now().isoformat(),
            }

        image = cv2.imread(image_path)
        target_path_for_ocr = image_path

        if image is None:
            raise ValueError("无法读取图像文件")
        
        # 检测文档方向
        print(f"  ↳ 检测文档方向...", end="", flush=True)
        with Timer() as orient_timer:
            # 方向检测结果会在 OCR 过程中自动处理
            pass
        print(f" {orient_timer.elapsed_str}")
        
        # 执行 OCR 识别
        print(f"  ↳ 执行文本识别...", end="", flush=True)
        with Timer() as ocr_timer:
            ocr_output = ocr_pipeline.predict(input=target_path_for_ocr)
        print(f" {ocr_timer.elapsed_str}")
        
        # 提取识别结果
        print(f"  ↳ 提取识别结果...", end="", flush=True)
        with Timer() as extract_timer:
            result_data = extract_ocr_result(ocr_output)
        print(result_data)
        print(f" {extract_timer.elapsed_str}")
        
        # 组织输出
        result = {
            "success": True,
            "task_id": task_id,
            "image_path": image_path,
            "is_pdf": is_pdf,
            "image_shape": {
                "height": image.shape[0],
                "width": image.shape[1],
                "channels": image.shape[2] if len(image.shape) > 2 else 1
            },
            "recognition_result": result_data,
            "timing": {
                "document_orientation_detection": orient_timer.elapsed,
                "ocr_recognition": ocr_timer.elapsed,
                "result_extraction": extract_timer.elapsed,
                "total": orient_timer.elapsed + ocr_timer.elapsed + extract_timer.elapsed
            },
            "timestamp": datetime.now().isoformat()
        }

        return result
        
    except Exception as e:
        print(f"\n  ✗ 识别失败: {e}")
        traceback.print_exc()
        raise


def _load_pipeline_in_background() -> None:
    """后台加载模型：HTTP 服务先启动，避免 compose 长时间 Waiting。"""
    global ocr_pipeline, ocr_model_loading, ocr_model_load_error
    ocr_model_loading = True
    ocr_model_load_error = None
    print("OCR 模型后台加载开始…", flush=True)
    try:
        result = init_offline_pipeline()
        if result["status"] != "success":
            ocr_model_load_error = result.get("error", "模型初始化失败")
            print(f"\n警告: OCR 管道初始化失败: {ocr_model_load_error}\n", flush=True)
    except Exception as exc:
        ocr_model_load_error = str(exc)
        print(f"\n警告: OCR 管道初始化异常: {exc}\n", flush=True)
        traceback.print_exc()
    finally:
        ocr_model_loading = False
        if ocr_pipeline is not None:
            print("OCR 模型加载完成，识别服务已就绪", flush=True)
        else:
            print(f"OCR 模型未就绪: {ocr_model_load_error}", flush=True)


@app.on_event("startup")
async def startup_event():
    """启动 HTTP 服务，模型在后台线程加载。"""
    thread = threading.Thread(
        target=_load_pipeline_in_background,
        daemon=True,
        name="ocr-model-loader",
    )
    thread.start()
    print("HTTP 服务已启动，OCR 模型在后台加载中（识别需等加载完成）", flush=True)


def _ocr_not_ready_message() -> str:
    if ocr_model_loading:
        return "OCR 模型正在加载中，请稍后再试"
    if ocr_model_load_error:
        return f"OCR 模型加载失败: {ocr_model_load_error}"
    return "OCR 管道未初始化，请检查模型文件"


@app.get("/")
async def root():
    """API 根路径"""
    return {
        "name": "PaddleOCR-VL 离线识别 API",
        "version": "1.0.0",
        "description": "基于本地预训练模型的完全离线 OCR API",
        "features": {
            "offline_inference": True,
            "layout_detection": True,
            "document_orientation_classification": True,
            "multi_language_support": True,
            "local_model_deployment": True
        },
        "endpoints": {
            "GET /api/models/status": "查看模型状态",
            "GET /api/models/info": "获取模型详细信息",
            "POST /api/recognize/image": "识别单个图像",
            "POST /api/recognize/batch": "批量识别多个图像",
            "GET /health": "健康检查"
        },
        "documentation": "http://localhost:8000/docs"
    }


@app.get("/health")
async def health_check():
    """健康检查端点"""
    return {
        "status": "healthy" if ocr_pipeline is not None else "loading",
        "ocr_pipeline_ready": ocr_pipeline is not None,
        "ocr_model_loading": ocr_model_loading,
        "ocr_model_load_error": ocr_model_load_error,
        "model": "PaddleOCRVL (Offline)",
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/models/status")
async def get_models_status():
    """获取模型状态"""
    investigator = OfflineModelInvestigator()
    models_status = investigator.check_local_models()
    
    return {
        "status": "success",
        "models": models_status,
        "pipeline_ready": ocr_pipeline is not None,
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/models/info")
async def get_models_info():
    """获取模型详细信息"""
    investigator = OfflineModelInvestigator()
    model_info = investigator.get_model_info()
    performance_info = investigator.investigate_model_performance()
    
    return {
        "status": "success",
        "model_info": model_info,
        "performance_info": performance_info,
        "timestamp": datetime.now().isoformat()
    }


@app.post("/api/recognize/image")
async def recognize_single_image(file: UploadFile = File(...)):
    """
    识别单个图像
    
    Args:
        file: 上传的图像文件
        
    Returns:
        JSON 格式的识别结果
    """
    if ocr_pipeline is None:
        raise HTTPException(status_code=503, detail=_ocr_not_ready_message())
    
    task_id = str(uuid.uuid4())
    temp_path = None
    
    try:
        # 保存临时文件
        contents = await file.read()
        temp_path = TEMP_DIR / f"{task_id}_{file.filename}"
        
        with open(temp_path, 'wb') as f:
            f.write(contents)
        
        print(f"\n[识别请求] task_id: {task_id}")
        print(f"  文件: {file.filename}")
        print(f"  处理步骤:")
        
        with Timer() as total_timer:
            # 执行识别
            result = recognize_image(str(temp_path), task_id)
        
        result["total_processing_time"] = total_timer.elapsed
        
        print(f"\n  ✓ 识别完成，总耗时: {total_timer.elapsed_str}")
        if result.get("page_count"):
            print(f"  PDF 页数: {result['page_count']}")
        print(f"  识别文本块数: {result['recognition_result']['total_blocks']}\n")
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "data": result
            }
        )
        
    except Exception as e:
        print(f"[错误] 识别失败: {e}\n")
        raise HTTPException(status_code=500, detail=f"识别失败: {str(e)}")
    
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except:
                pass
        if temp_path:
            for page_file in Path(str(temp_path)).parent.glob(f"{temp_path.name}_page*.jpg"):
                try:
                    os.remove(page_file)
                except:
                    pass


@app.post("/api/recognize/batch")
async def recognize_batch_images(files: List[UploadFile] = File(...)):
    """
    批量识别多个图像
    
    Args:
        files: 上传的多个图像文件
        
    Returns:
        JSON 格式的批量识别结果
    """
    if ocr_pipeline is None:
        raise HTTPException(status_code=503, detail=_ocr_not_ready_message())
    
    batch_id = str(uuid.uuid4())
    results = []
    temp_paths = []
    
    print(f"\n[批量识别] batch_id: {batch_id}")
    print(f"  文件数: {len(files)}")
    print(f"  处理列表:\n")
    
    total_blocks = 0
    
    with Timer() as batch_timer:
        for idx, file in enumerate(files, 1):
            task_id = str(uuid.uuid4())
            temp_path = None
            
            try:
                # 保存临时文件
                contents = await file.read()
                temp_path = TEMP_DIR / f"{task_id}_{file.filename}"
                
                with open(temp_path, 'wb') as f:
                    f.write(contents)
                
                temp_paths.append(temp_path)
                
                print(f"  [{idx}/{len(files)}] {file.filename}", end="", flush=True)
                
                with Timer() as timer:
                    result = recognize_image(str(temp_path), task_id)
                
                total_blocks += result['recognition_result']['total_blocks']
                
                print(f" ✓ ({timer.elapsed_str})\n")
                
                results.append({
                    "success": True,
                    "filename": file.filename,
                    **result
                })
                
            except Exception as e:
                print(f" ✗ ({str(e)})\n")
                results.append({
                    "success": False,
                    "filename": file.filename,
                    "task_id": task_id,
                    "error": str(e)
                })
    
    # 统计
    success_count = sum(1 for r in results if r.get('success', False))
    
    print(f"  ✓ 批处理完成")
    print(f"    总耗时: {batch_timer.elapsed_str}")
    print(f"    成功: {success_count}/{len(files)}")
    print(f"    总文本块: {total_blocks}\n")
    
    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            "batch_id": batch_id,
            "total_files": len(files),
            "successful": success_count,
            "failed": len(files) - success_count,
            "total_text_blocks": total_blocks,
            "total_processing_time": batch_timer.elapsed,
            "results": results
        }
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    )
