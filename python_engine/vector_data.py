import os

import geopandas as gpd
import pandas as pd
from sqlalchemy import create_engine


PG_URI = os.getenv("PG_URI", "postgresql://geocsv:geocsv@127.0.0.1:5432/geocsv")
engine = create_engine(PG_URI, pool_size=10, max_overflow=20)


def flatten_vector_frame(df):
    if df.empty:
        return df

    if df.crs is None:
        df = df.set_crs(epsg=4326)

    flat_df = df.copy()
    flat_df['__record_id__'] = flat_df['id']

    df_props = pd.json_normalize(flat_df['properties'])
    if 'id' not in df_props.columns:
        df_props['id'] = flat_df['id']

    merged = pd.concat([flat_df[['geom', '__record_id__']], df_props], axis=1)
    merged = merged.loc[:, ~merged.columns.duplicated()]
    return gpd.GeoDataFrame(merged, geometry='geom', crs=df.crs)
