import numpy as np
from PIL import Image

def get_png_element_list(file_path):
    # 使用 PIL 打开图像并转为 numpy 数组
    img = Image.open(file_path)
    img_array = np.array(img)

    # 获取图中所有唯一的像素值 (即元素列表)
    unique_elements = np.unique(img_array)

    print(f"文件: {file_path}")
    print(f"图中包含的唯一元素 ID 列表: {unique_elements.tolist()}")
    print(f"总计元素个数: {len(unique_elements)}")
    
    return unique_elements

# 使用示例
elements = get_png_element_list("panoptic/1661922776.200000_gtFine_labelIds.png")
