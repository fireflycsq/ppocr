"""对外抽取 API 使用的内置版式、字段定义与默认 Ollama 请求。

提示词与字段与前端 `src/utils/labelTemplates.ts` / `src/utils/llmConfig.ts` 对齐。
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, TypedDict


PAGE_IMAGE_PLACEHOLDER = "{{PAGE_IMAGE}}"
DEFAULT_LLM_MODEL = os.environ.get("EXTRACT_LLM_MODEL", "qwen3-vl:4b")


class FieldDef(TypedDict):
    id: str
    key: str
    label: str


class ExtractTemplate(TypedDict):
    id: str
    name: str
    description: str
    header_fields: List[FieldDef]
    sublist_columns: List[FieldDef]
    required_sublist_keys: List[str]


TARGET_INVOICE_SYSTEM_PROMPT = "\n".join(
    [
        "你是专业的发票信息抽取助手。先判断传入的页面图片是否为目标单证：非目标单证不抽取任何字段；目标单证按用户要求精准抽取指定字段。",
        "你必须只输出一个合法的 JSON 对象，禁止输出解释、注释或 Markdown 代码块。",
        "只依据当前页图片作答，禁止编造图片中不存在的内容，禁止照抄示例中的具体值。",
        "整页只输出一次 JSON，完成后立即停止，禁止重复输出相同结构。",
    ]
)

AIR_WAYBILL_USER_PROMPT = """### 目标单证判定（is_target）
当前页必须同时满足以下 3 个特征，才判定为目标单证（is_target=true）：
1. 页面顶部中央印有 `INVOICE 發票`（下方通常有 `DUTIES, TAXES & OTHER CHARGES 進口關稅及其他收費`），页面带有 `Page` 页码；
2. 页面包含明细区域 `Details by Payment Type 詳細資料(按付款項目)`；
3. 明细区域中至少出现一处 `Air Waybill Number 空運提單號` 标签及其对应编号。

出现以下任一情况判为非目标单证（is_target=false，invoices 与 orphan_sublist 均输出 []，不抽取任何字段）：
- 汇总首页：只有 `Summary by Payment Type 付款項目摘要`、`Grand Total 總計`、付款方式说明（FPS、QR Pay、银行账户等）或 `Remittance Slip 郵遞付款單`，没有任何 `Air Waybill Number 空運提單號` 明细；
- 封面页、付款通知/回执、合同条款、报关随附资料、空白页；
- 页面虽印有 `INVOICE 發票`，但没有按付款项目的明细块。

### 字段抽取（仅当 is_target=true 时执行）
1. 发票头 header（页面上部信息区）：
   - invoice_no：`Invoice Number 發票號碼` 标签右侧或下方的编号；
   - invoice_date：`Invoice Date 發票日期` 标签右侧或下方的日期，保持原文格式。
2. 明细 sublist（一个明细块输出一行，逐块抽取、不合并、不遗漏）：
   - 分块：以 `Ship Date 寄件日期` 开头、以 `Total 合計` 结尾的区域为一个独立明细块；
   - air_waybill_number：该块内必须先出现 `Air Waybill Number 空運提單號` 标签，再提取其同一行右侧的编号；
     **严禁**把没有该标签的孤立数字串（如 Reference 联邦快递参考资料、Shipper Reference、页码、账号等）当作运单号；
     块内找不到 `Air Waybill Number 空運提單號` 标签时，整块丢弃，不要输出；
   - total：该块内 `Total 合計` 标签同一行右侧的金额，必须是该块最终合计，严禁取 `Other Charges 其它費用`、`Duty & Tax 稅項`、`Conversion Rate 兌換率` 等其他数字；
   - 页面底部的 `Bill Shipper Subtotal` 小计行不是明细块，严禁作为明细输出。

### 数据清洗
- total 只保留数字、小数点与负号，去掉 HKD、$、逗号与空格；
- invoice_no、air_waybill_number 保持原文字符串，仅去除首尾空格；
- 某字段缺失时对应值填 null；本页没有有效明细时 sublist 输出 []；
- 本页只有明细块、发票头出现在之前页时：明细放入 orphan_sublist，invoices 输出 []。

### 输出格式
只输出一个标准 JSON 对象，禁止 Markdown 标记、解释说明或重复文本。结构如下（示例值仅示意结构，禁止照抄）：
{
  "is_target": true,
  "invoices": [
    {
      "header": {"invoice_no": "12345678", "invoice_date": "01 Nov 2025"},
      "sublist": [
        {"air_waybill_number": "999-12345678", "total": "1500.00"}
      ]
    }
  ],
  "orphan_sublist": []
}

当 is_target 为 false 时，invoices 与 orphan_sublist 必须为空数组 []。"""

AIR_WAYBILL_DHL_USER_PROMPT = """### 目标单证判定（is_target）
当前页必须同时满足以下 2 个特征，才判定为目标单证（is_target=true）：
1. 页面包含运单明细表格，表头出现 `Air Waybill Number`、`Shipment Date`、`Origin / Consignor`、`Destination / Consignee`、`Total` 等列；
2. `Air Waybill Number` 列下方至少有一个具体的运单号。

出现以下任一情况判为非目标单证（is_target=false，invoices 与 orphan_sublist 均输出 []，不抽取任何字段）：
- 汇总首页：只有 `Type of Service` 汇总表、`Analysis of Extra Charges`（附加费分析）、`Total Amount (HKD)`、`Payment Instructions`（付款指引）或银行转账/支票付款说明，没有运单明细表格；
- 只有汇总金额、说明文字而没有任何具体运单号的页面；
- 封面页、合同条款、报关随附资料、空白页。

### 字段抽取（仅当 is_target=true 时执行）
1. 发票头 header（页面上部的发票信息框）：
   - invoice_no：`Invoice Number` 标签右侧的编号，必须是长度为 13 的字符串（如 HKGIR02836829）；长度不是 13 时仍按原文输出，不要擅自补全；
   - invoice_date：`Invoice Date` 标签右侧的日期，保持原文格式。
2. 明细 sublist（一个运单号对应一个明细块，一块输出一行，不合并、不遗漏）：
   - 分块：从某个 `Air Waybill Number` 开始，到下一个运单号出现之前（或本页表格结束）为一个独立运单块；
   - air_waybill_number：该块 `Air Waybill Number` 列中的运单号；
   - total：该运单块最右侧 `Total` 列中、块内最下方的那个金额（标准运费 + 全部附加费之后的最终合计）。
     **严禁取以下数字作为 total**：
     - 主行上的 `Standard Charge` / `Standard Shipping Charge`（常与 Total 列同值出现在块顶部，如 275.03）；
     - `Extra Charges Amount` 列中的单条附加费（如 FUEL SURCHARGE、DEMAND SURCHARGE、GOGREEN PLUS、REGULATORY CHARGES、DUTY TAX PAID）；
     - 块内任何中间行的金额。
     正确做法：先定位该运单块的起止范围，再取 `Total` 列最底部的数字（如块内有 275.03 与 375.78 时，必须取 375.78）。
   - `Service Sub Total`、`Total: HKD:` 等小计/合计行不是运单明细，严禁输出；
   - 没有运单号的行直接丢弃，不要输出。

### 数据清洗
- total 只保留数字、小数点与负号，去掉货币符号、逗号与空格；
- invoice_no 保持原文字符串（预期长度 13），仅去除首尾空格；
- air_waybill_number 保持原文字符串，仅去除首尾空格；
- 某字段缺失时对应值填 null；本页没有有效明细时 sublist 输出 []；
- 本页只有运单明细、发票头出现在之前页时：明细放入 orphan_sublist，invoices 输出 []。

### 输出格式
只输出一个标准 JSON 对象，禁止 Markdown 标记、解释说明或重复文本。结构如下（示例值仅示意结构，禁止照抄）：
{
  "is_target": true,
  "invoices": [
    {
      "header": {"invoice_no": "HKGIR02836829", "invoice_date": "01 Nov 2025"},
      "sublist": [
        {"air_waybill_number": "1234567890", "total": "1500.00"}
      ]
    }
  ],
  "orphan_sublist": []
}

当 is_target 为 false 时，invoices 与 orphan_sublist 必须为空数组 []。"""

FREIGHT_INVOICE_USER_PROMPT = """### 目标单证判定（is_target）
当前页必须同时满足以下 2 个特征，才判定为目标单证（is_target=true）：
1. 页面为正式货运/海运发票：上部印有 `INVOICE` 及紧随其后的发票编号，右侧有发票信息网格表（`INVOICE DATE`、`CUSTOMER ID`、`SHIPMENT`、`DUE DATE`、`TERMS`、`INCOTERM` 等），中部有 `SHIPMENT DETAILS` 装运信息区域；
2. 页面包含 `CHARGES` 费用明细表格（列头为 `DESCRIPTION` 与 `CHARGES IN HKD`），且至少有一行费用项目（费用描述 + 金额）。

出现以下任一情况判为非目标单证（is_target=false，invoices 与 orphan_sublist 均输出 []，不抽取任何字段）：
- 纯付款通知/付款回执（Payment Advice）、对账单、封面页、合同条款、报关随附资料、空白页；
- 页面只有地址、合计金额或说明文字，没有任何费用明细行；
- 页面左上方没有大写 `INVOICE` 字样及其后紧跟的 11 位发票编号；
- 可抽取的有效字段（非空 header 字段）少于 5 个。

### 字段抽取（仅当 is_target=true 时执行）
1. 发票头 header：
   - supplier：页面右上角的公司抬头名称（发票开具方）；
   - invoice_no：页面左上方大写 `INVOICE` 字样右侧紧跟的发票编号，必须是长度恰好为 11 的字符串（如 GHK01256555）；不是 11 位则本页判为非目标；
   - invoice_date：右侧网格表 `INVOICE DATE` 的日期，保持原文格式；
   - terms：网格表 `TERMS` 的付款条款（如 15 days from Inv. Date）；
   - incoterm：网格表 `INCOTERM` 的贸易条款（如 FOB - Free On Board）；
   - weight：`SHIPMENT DETAILS` 区域 `WEIGHT` 的值（含单位）；
   - volume：`SHIPMENT DETAILS` 区域 `VOLUME` 的值（含单位）；
   - packages：`SHIPMENT DETAILS` 区域 `PACKAGES` 的值；
   - vessel_voyage_imo：`VESSEL / VOYAGE / IMO(LLOYDS)` 单元格的内容；
   - house_bill_of_lading：`HOUSE BILL OF LADING` 单元格的提单号，严禁取 `OCEAN BILL OF LADING` 的编号；
   - total_hkd：页面底部 `TOTAL CHARGES` 区域中 `TOTAL HKD` 的金额，严禁取 `SUBTOTAL` 的金额。
2. 费用明细 sublist（`CHARGES` 表格逐行读取，一行费用输出一行，不合并、不遗漏）：
   - description：`DESCRIPTION` 列的费用描述；
   - charges_in_hkd：同一行 `CHARGES IN HKD` 列的金额；
   - `SUBTOTAL`、`TOTAL HKD` 等小计/合计行不属于费用明细，严禁放入 sublist；没有费用描述的行直接丢弃。

### 数据清洗
- charges_in_hkd、total_hkd 只保留数字、小数点与负号，去掉 HKD、$、逗号与空格；
- 其余字段保持原文字符串，仅去除首尾空格；
- 某字段缺失时对应值填 null；本页没有有效明细时 sublist 输出 []；
- 本页只有费用明细、发票头出现在之前页时：明细放入 orphan_sublist，invoices 输出 []。

### 输出格式
只输出一个标准 JSON 对象，禁止 Markdown 标记、解释说明或重复文本。结构如下（示例值仅示意结构，禁止照抄）：
{
  "is_target": true,
  "invoices": [
    {
      "header": {
        "supplier": "GEODIS Hong Kong Limited",
        "invoice_no": "GHK01256555",
        "invoice_date": "01 Nov 2025",
        "incoterm": "FOB - Free On Board",
        "terms": "15 days from Inv. Date",
        "weight": "100.00 KGM",
        "volume": "1.00 CBM",
        "packages": "10",
        "vessel_voyage_imo": "VESSEL 123W",
        "house_bill_of_lading": "HBL12345678",
        "total_hkd": "1925.00"
      },
      "sublist": [
        {"description": "Bill of Lading Fee - Base Rate HKD 650.00", "charges_in_hkd": "650.00"}
      ]
    }
  ],
  "orphan_sublist": []
}

当 is_target 为 false 时，invoices 与 orphan_sublist 必须为空数组 []。"""

AIR_WAYBILL_EXTRACT_OPTIONS: Dict[str, Any] = {
    "temperature": 0,
    "num_ctx": 25600,
    "num_predict": 12288,
    "repeat_penalty": 1.1,
}

DEFAULT_EXTRACT_OPTIONS: Dict[str, Any] = {
    "temperature": 0,
    "num_ctx": 8192,
    "num_predict": 4096,
}

TEMPLATES: Dict[str, ExtractTemplate] = {
    "air_waybill": {
        "id": "air_waybill",
        "name": "空运单版式（FedEx）",
        "description": "发票号码、发票日期 + 空中运输单编号 / 收费（INVOICE 發票双语发票）",
        "header_fields": [
            {"id": "h1", "key": "invoice_no", "label": "发票号码"},
            {"id": "h2", "key": "invoice_date", "label": "发票日期"},
        ],
        "sublist_columns": [
            {
                "id": "c1",
                "key": "air_waybill_number",
                "label": "空中运输单编号（Air Waybill Number）",
            },
            {"id": "c2", "key": "total", "label": "收费（Total）"},
        ],
        "required_sublist_keys": ["air_waybill_number"],
    },
    "air_waybill_dhl": {
        "id": "air_waybill_dhl",
        "name": "空运单版式（DHL）",
        "description": "发票号码、发票日期 + 空中运输单编号 / 收费（DHL 发票）",
        "header_fields": [
            {"id": "dh1", "key": "invoice_no", "label": "发票号码"},
            {"id": "dh2", "key": "invoice_date", "label": "发票日期"},
        ],
        "sublist_columns": [
            {
                "id": "dc1",
                "key": "air_waybill_number",
                "label": "空中运输单编号（Air Waybill Number）",
            },
            {"id": "dc2", "key": "total", "label": "收费（Total）"},
        ],
        "required_sublist_keys": ["air_waybill_number"],
    },
    "freight_invoice": {
        "id": "freight_invoice",
        "name": "货运发票版式",
        "description": "GEODIS 货运发票：完整发票头 + 描述 / 收费明细",
        "header_fields": [
            {"id": "fh1", "key": "invoice_no", "label": "发票号"},
            {"id": "fh2", "key": "invoice_date", "label": "发票日期"},
            {"id": "fh3", "key": "packages", "label": "包裹（packages）"},
            {"id": "fh4", "key": "volume", "label": "体积（volume）"},
            {"id": "fh5", "key": "weight", "label": "重量（weight）"},
            {"id": "fh6", "key": "terms", "label": "条款（terms）"},
            {"id": "fh7", "key": "incoterm", "label": "国贸条规（incoterm）"},
            {"id": "fh8", "key": "supplier", "label": "供应商（supplier）"},
            {
                "id": "fh9",
                "key": "vessel_voyage_imo",
                "label": "船舶航行国际海事组织（劳埃德）（VESSEL VOYAGE IMO(LLOYDS)）",
            },
            {
                "id": "fh10",
                "key": "house_bill_of_lading",
                "label": "提单（HOUSE BILL OF LADING）",
            },
            {"id": "fh11", "key": "total_hkd", "label": "合计（TOTAL_HKD）"},
        ],
        "sublist_columns": [
            {"id": "fc1", "key": "description", "label": "描述（DESCRIPTION）"},
            {"id": "fc2", "key": "charges_in_hkd", "label": "收费（CHARGES IN HKD）"},
        ],
        "required_sublist_keys": ["description"],
    },
}

_USER_PROMPTS = {
    "air_waybill": AIR_WAYBILL_USER_PROMPT,
    "air_waybill_dhl": AIR_WAYBILL_DHL_USER_PROMPT,
    "freight_invoice": FREIGHT_INVOICE_USER_PROMPT,
}

AIR_WAYBILL_TEMPLATE_IDS = {"air_waybill", "air_waybill_dhl"}


class UnknownTemplateError(ValueError):
    pass


def list_templates() -> List[ExtractTemplate]:
    return [dict(TEMPLATES[key]) for key in TEMPLATES]


def get_template(template_id: str) -> ExtractTemplate:
    template = TEMPLATES.get(template_id)
    if not template:
        known = ", ".join(TEMPLATES)
        raise UnknownTemplateError(
            f"未知版式 `{template_id}`，可选：{known}"
        )
    return dict(template)


def public_template(template: ExtractTemplate) -> Dict[str, Any]:
    return {
        "id": template["id"],
        "name": template["name"],
        "description": template["description"],
        "header_fields": [
            {"key": field["key"], "label": field["label"]}
            for field in template["header_fields"]
        ],
        "sublist_columns": [
            {"key": field["key"], "label": field["label"]}
            for field in template["sublist_columns"]
        ],
        "required_sublist_keys": list(template["required_sublist_keys"]),
        "output_shape": _output_shape(template),
    }


def _output_shape(template: ExtractTemplate) -> Dict[str, Any]:
    header = {field["key"]: "string" for field in template["header_fields"]}
    row = {field["key"]: "string" for field in template["sublist_columns"]}
    return {
        "structure_type": "invoice_with_sublist | multi_invoice | multi_invoice_with_sublist | single",
        "invoice": header,
        "sublist": [row],
    }


def default_options_for(template_id: str) -> Dict[str, Any]:
    if template_id in AIR_WAYBILL_TEMPLATE_IDS:
        return dict(AIR_WAYBILL_EXTRACT_OPTIONS)
    return dict(DEFAULT_EXTRACT_OPTIONS)


def build_request_json(
    template_id: str, llm_model: Optional[str] = None
) -> str:
    template = get_template(template_id)
    model = (llm_model or "").strip() or DEFAULT_LLM_MODEL
    body = {
        "model": model,
        "stream": True,
        "think": False,
        "format": "json",
        "options": default_options_for(template_id),
        "messages": [
            {"role": "system", "content": TARGET_INVOICE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _USER_PROMPTS[template["id"]],
                "images": [PAGE_IMAGE_PLACEHOLDER],
            },
        ],
    }
    return json.dumps(body, ensure_ascii=False)
