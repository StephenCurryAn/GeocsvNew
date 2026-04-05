import numpy as np
def execute(df, parameters):
    try:
        projected_gdf = df.to_crs(df.estimate_utm_crs())
        perimeter = projected_gdf.geometry.length.tolist()
        return {'perimeter': perimeter}
    except Exception as e:
        print(f"Error calculating perimeter: {str(e)}")
        return {'perimeter': [np.nan] * len(df)}