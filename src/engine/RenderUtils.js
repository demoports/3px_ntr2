export function renderWithoutClearing( renderer, scene, camera ) {

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    try {

        renderer.render( scene, camera );

    } finally {

        renderer.autoClear = autoClear;

    }

}

export function disposeSceneGeometries( scenes ) {

    for ( const scene of scenes ) {

        for ( const child of scene.children ) child.geometry?.dispose();

    }

}
