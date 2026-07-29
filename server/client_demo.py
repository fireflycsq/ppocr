#!/usr/bin/env python3
"""
PaddleOCR-VL API 客户端调用示例
需要安装依赖: pip install requests
"""

import os
import requests
import json
from pathlib import Path

# 配置服务基础 URL
BASE_URL = "http://localhost:8000"

def check_health():
    """1. 健康检查"""
    print("=== 1. 正在检查服务健康状态 ===")
    try:
        response = requests.get(f"{BASE_URL}/health")
        if response.status_code == 200:
            print("服务状态:", json.dumps(response.json(), indent=2, ensure_ascii=False))
        else:
            print(f"服务异常，状态码: {response.status_code}")
    except requests.exceptions.ConnectionError:
        print(f"无法连接到服务，请确保 FastAPI 服务已在 {BASE_URL} 启动。")
    print("-" * 50)

def get_models_status():
    """2. 获取模型状态信息"""
    print("=== 2. 获取本地模型状态 ===")
    try:
        response = requests.get(f"{BASE_URL}/api/models/status")
        if response.status_code == 200:
            print("模型状态:", json.dumps(response.json(), indent=2, ensure_ascii=False))
        else:
            print(f"获取失败，状态码: {response.status_code}")
    except Exception as e:
        print(f"发生错误: {e}")
    print("-" * 50)

def recognize_single_image(image_path):
    """3. 识别单张图片"""
    print(f"=== 3. 正在识别单张图片: {image_path} ===")
    if not os.path.exists(image_path):
        print(f"错误: 找不到测试图片 {image_path}，请修改路径后再试。")
        print("-" * 50)
        return

    url = f"{BASE_URL}/api/recognize/image"
    
    # 以二进制表单（Multipart/form-data）形式上传文件
    with open(image_path, "rb") as f:
        files = {"file": (os.path.basename(image_path), f, "image/jpeg")}
        try:
            response = requests.post(url, files=files)
            if response.status_code == 200:
                result = response.json()
                print("【识别成功】")
                print(result)
                # 打印提取出的完整文本
                extracted_text = result["data"]["recognition_result"]["extracted_text"]
                print(f"--- 提取到的文本内容 ---\n{extracted_text}\n-----------------------")
                # 打印耗时
                print(f"总处理耗时: {result['data']['total_processing_time']:.2f} 秒")
            else:
                print(f"识别失败，错误信息: {response.text}")
        except Exception as e:
            print(f"发生错误: {e}")
    print("-" * 50)

def recognize_batch_images(image_paths):
    """4. 批量识别多张图片"""
    print(f"=== 4. 正在批量识别图片，共 {len(image_paths)} 张 ===")
    url = f"{BASE_URL}/api/recognize/batch"
    
    # 构造多个文件上传的列表，注意这里的 key 必须是 'files'，对应后端接口里的 files: List[UploadFile]
    files_payload = []
    opened_files = []
    
    for path in image_paths:
        if os.path.exists(path):
            f = open(path, "rb")
            opened_files.append(f)
            files_payload.append(("files", (os.path.basename(path), f, "image/jpeg")))
        else:
            print(f"跳过不存在的文件: {path}")

    if not files_payload:
        print("没有可用于批量识别的有效图片。")
        print("-" * 50)
        return

    try:
        response = requests.post(url, files=files_payload)
        if response.status_code == 200:
            result = response.json()
            print("【批量处理成功】")
            print(f"成功率: {result['successful']}/{result['total_files']}")
            print(f"总批量耗时: {result['total_processing_time']:.2f} 秒")
            
            # 循环打印每张图的结果概要
            for res in result["results"]:
                if res["success"]:
                    text_summary = res["recognition_result"]["extracted_text"].replace("\n", " ")[:30]
                    print(f" -> 文件: {res['filename']} | 成功 | 文本摘要: {text_summary}...")
                else:
                    print(f" -> 文件: {res['filename']} | 失败 | 错误: {res.get('error')}")
        else:
            print(f"批量请求失败，状态码: {response.status_code}，详情: {response.text}")
    except Exception as e:
        print(f"发生错误: {e}")
    finally:
        # 关闭所有打开的文件
        for f in opened_files:
            f.close()
    print("-" * 50)


if __name__ == "__main__":
    # 先确保你本地有用来测试的图片，这里假设在当前目录下有 test1.jpg 和 test2.jpg
    # 你可以替换成你真实的图片绝对路径或相对路径
    TEST_IMAGE_1 = "/data/ocr_test_document.pdf"
    
    # 创建临时的伪测试图片（如果当前目录下没有图片的话，方便你直接运行看效果）
    for img in [TEST_IMAGE_1]:
        if not os.path.exists(img):
            with open(img, "wb") as f:
                f.write(b"fake image bytes")  # 真实测试请换成包含文字的真图片

    # 执行调用流程
    check_health()
    get_models_status()
    recognize_single_image(TEST_IMAGE_1)
    #recognize_batch_images([TEST_IMAGE_1])
