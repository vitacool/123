# -*- coding: utf-8 -*-
"""生成《食品科普视频清单》xlsx。"""
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT = r"C:\Users\blueb\Documents\deepseek-harness\default-workspace\食品科普视频清单.xlsx"

HEADERS = ["序号", "UP主", "视频标题", "链接/主页", "类型", "时长", "播放量", "名称核对", "备注"]

ROWS = [
    (1, "大雷的食品科普日常",
     "白砂糖 VS 果葡糖浆，到底谁更健康？",
     "https://www.bilibili.com/video/BV1gNsM6uE1o", "视频", "3:03", 12619, "一致",
     "食品厂从业者视角，3分钟短讲"),
    (2, "兔叭咯", "【医学博士】咖啡，是续命，还是透支生命？｜为什么咖啡越喝越困？",
     "https://www.bilibili.com/video/BV1bufiBFEY2", "视频", "5:19", None, "用户写作“兔扒咯”，实际为“兔叭咯”",
     "医学博士系列；播放量接口被限，未取到"),
    (3, "万物实验室", "快扔掉奶茶！失明、截肢，糖尿病怎么看上了年轻人？",
     "https://www.bilibili.com/video/BV1WQ4y1i7qf", "视频", "6:47", 251336, "实际账号名为“万能实验室”",
     "糖尿病与含糖饮料，标题偏警示"),
    (4, "世界探索站", "10种“饱腹感超强”的食物，看似是素食，实则“比肥肉还抗饿”，第一种吃一碗顶一天！",
     "https://www.bilibili.com/video/BV1q3m9BhE5F", "视频", "4:48", 253661, "一致",
     "页面标注“该视频使用人工智能合成技术”"),
    (5, "赛博食物录", "临期食品那么便宜，吃下去真的没问题吗？【食录】",
     "https://www.bilibili.com/video/BV12H4y1m7aC", "视频", "10:03", 7369220, "实际账号名为“赛博食录”",
     "合集《食品工业》单集；本表播放量最高的一条"),
    (6, "迈亚塔可", "（主页链接，非单条视频）",
     "https://space.bilibili.com/3546873824545017", "UP主主页", "—", None, "未能自动核验",
     "你给的是个人空间地址；账号名以页面为准"),
    (7, "戴嘴馋", "为什么奶茶越来越不像奶茶了？",
     "https://www.bilibili.com/video/BV1RhJD6XE9S", "视频", "6:57", 38930, "一致",
     "奶茶产品形态变化"),
    (8, "饮食文化历史探究室", "采芹献芹美芹 为啥说的又不是我们常吃的芹菜？中国芹菜千年简史",
     "https://www.bilibili.com/video/BV1nUxB65Eq2", "视频", "6:32", 48662, "一致",
     "UP主一周年作品；合集《中国食材史话》"),
]

NOTES = [
    "数据来源：B 站公开视频接口（标题、时长、播放量、UP主名称），采样时间 2026-11-17。",
    "时长按接口返回的秒数换算为“分:秒”，四舍五入到秒，不按“约”处理。",
    "“播放量”为动态数据，会随时间变化；空值表示未能取到（接口风控或非视频页面）。",
    "名称核对：第2、3、5行你提供的 UP 主名称与 B 站实际账号名有出入，已在表中列出实际名称。",
    "第6行为个人主页而非视频，因此没有时长与播放量。",
]

wb = Workbook()
ws = wb.active
ws.title = "视频清单"

head_fill = PatternFill("solid", fgColor="1F4E79")
alt_fill = PatternFill("solid", fgColor="F2F6FA")
thin = Side(style="thin", color="B7C6D9")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

# 表头
for col, name in enumerate(HEADERS, start=1):
    c = ws.cell(row=1, column=col, value=name)
    c.font = Font(bold=True, color="FFFFFF", size=11)
    c.fill = head_fill
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    c.border = border

# 数据
for i, row in enumerate(ROWS, start=2):
    for col, value in enumerate(row, start=1):
        c = ws.cell(row=i, column=col, value=value)
        c.border = border
        c.alignment = Alignment(
            vertical="center",
            wrap_text=(col in (3, 9)),
            horizontal="center" if col in (1, 5, 6, 7, 8) else "left",
        )
    if i % 2 == 0:
        for col in range(1, len(HEADERS) + 1):
            ws.cell(row=i, column=col).fill = alt_fill

# 链接列做超链接
for i, row in enumerate(ROWS, start=2):
    c = ws.cell(row=i, column=4)
    c.hyperlink = row[3]
    c.font = Font(color="0563C1", underline="single")

# 播放量格式
for i in range(2, 2 + len(ROWS)):
    ws.cell(row=i, column=7).number_format = "#,##0"

widths = {"A": 6, "B": 20, "C": 58, "D": 44, "E": 11, "F": 8, "G": 12, "H": 26, "I": 34}
for col, w in widths.items():
    ws.column_dimensions[col].width = w

ws.row_dimensions[1].height = 30
for i in range(2, 2 + len(ROWS)):
    ws.row_dimensions[i].height = 44

ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}{1 + len(ROWS)}"

# 说明页
ws2 = wb.create_sheet("说明")
ws2.column_dimensions["A"].width = 100
ws2["A1"] = "数据说明"
ws2["A1"].font = Font(bold=True, size=13, color="1F4E79")
for idx, note in enumerate(NOTES, start=2):
    c = ws2.cell(row=idx, column=1, value=f"{idx-1}. {note}")
    c.alignment = Alignment(wrap_text=True, vertical="top")
    ws2.row_dimensions[idx].height = 32

wb.save(OUT)
print("saved:", OUT)