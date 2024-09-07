export interface ScoreMedia {
	metadata: { duration: number }
	mposXML: string
	sposXML: string
	svgs: string[]
}

export interface ScoreElement {
	x: number
	y: number
	sx: number
	sy: number
	page: number
}
